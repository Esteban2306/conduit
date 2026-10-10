import { Injectable, Logger } from '@nestjs/common';
import { ToolInvocationStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from 'src/shared/prisma.service';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { canonicalJson, setByPath } from './json-path.util';

/**
 * Headers con la identidad verificada del chat. Los pone Conduit (no el
 * modelo), así el backend puede imponerla y nadie puede, escribiéndole al
 * bot, operar sobre las reservas de otro número.
 */
export const CONTACT_PHONE_HEADER = 'X-Conduit-Contact-Phone';
export const CONTACT_LID_HEADER = 'X-Conduit-Contact-Lid';
export const CONVERSATION_HEADER = 'X-Conduit-Conversation-Id';

export interface AttachedImage {
  dataUri: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ToolCallRequest {
  toolDefinitionId: string;
  conversationId: string;
  params: Record<string, unknown>;
  attachedImage?: AttachedImage;
  imageParamName?: string;
  maxImageSizeBytes?: number;
  injectedPhone?: string;
  phoneParamName?: string;
  /** Dirección verificada del chat: dígitos del teléfono o "<lid>@lid". */
  contactAddress?: string;
  /**
   * Identifica el turno (lo que el cliente escribió y se está respondiendo).
   * Reintentos dentro del mismo turno comparten clave de idempotencia; un
   * turno nuevo (p. ej. volver a reservar tras cancelar) genera otra.
   */
  turnId?: string;
}

export interface ToolCallOutcome {
  status: ToolInvocationStatus;
  responseBody: unknown;
  httpStatus: number | null;
  errorDetail: string | null;
  invocationId: string | null;
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  private readonly DEFAULT_TIMEOUT_MS = 10_000;
  private readonly IMAGE_TIMEOUT_MS = 25_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: SecretEncryptionService,
  ) {}

  async execute(request: ToolCallRequest): Promise<ToolCallOutcome> {
    const tool = await this.prisma.toolDefinition.findUnique({
      where: { id: request.toolDefinitionId },
    });

    if (!tool || !tool.isActive) {
      return this.fail(
        null,
        ToolInvocationStatus.TECHNICAL_ERROR,
        null,
        null,
        'Tool no encontrada o inactiva',
      );
    }

    if (request.attachedImage) {
      const limit =
        request.maxImageSizeBytes ?? tool.maxImageSizeBytes ?? 8_388_608;
      if (request.attachedImage.sizeBytes > limit) {
        return this.fail(
          null,
          ToolInvocationStatus.BUSINESS_ERROR,
          null,
          null,
          `La imagen supera el límite permitido (${Math.round(limit / 1024 / 1024)}MB). ` +
            `Pide al cliente una foto de menor tamaño o resolución.`,
        );
      }
    }

    const finalParams = { ...request.params };

    if (request.attachedImage && request.imageParamName) {
      finalParams[request.imageParamName] = request.attachedImage.dataUri;
    }
    if (request.injectedPhone && request.phoneParamName) {
      setByPath(finalParams, request.phoneParamName, request.injectedPhone);
    }

    const method = (tool.httpMethod ?? 'POST').toUpperCase();
    const isReadOnly = READ_ONLY_METHODS.has(method);

    const headers: Record<string, string> = {};
    if (!isReadOnly) headers['Content-Type'] = 'application/json';

    headers[CONVERSATION_HEADER] = request.conversationId;
    if (request.contactAddress?.endsWith('@lid')) {
      headers[CONTACT_LID_HEADER] = request.contactAddress.replace('@lid', '');
    } else if (request.contactAddress) {
      headers[CONTACT_PHONE_HEADER] = `+${request.contactAddress}`;
    }

    if (tool.authHeaderName && tool.authSecretEncrypted) {
      headers[tool.authHeaderName] = this.encryption.decrypt(
        tool.authSecretEncrypted,
      );
    }

    let idempotencyKey: string | null = null;
    if (!isReadOnly) {
      idempotencyKey = this.computeIdempotencyKey(request, finalParams);
      headers['X-Conduit-Idempotency-Key'] = idempotencyKey;
    }

    const timeoutMs = request.attachedImage
      ? this.IMAGE_TIMEOUT_MS
      : this.DEFAULT_TIMEOUT_MS;

    try {
      const requestUrl = isReadOnly
        ? this.buildUrlWithQuery(tool.endpointUrl, finalParams)
        : tool.endpointUrl;

      const { response, body } = await this.callWithRetry(
        requestUrl,
        {
          method,
          headers,
          ...(isReadOnly ? {} : { body: JSON.stringify(finalParams) }),
        },
        timeoutMs,
      );

      const status = response.ok
        ? ToolInvocationStatus.SUCCESS
        : response.status >= 400 && response.status < 500
          ? ToolInvocationStatus.BUSINESS_ERROR
          : ToolInvocationStatus.TECHNICAL_ERROR;

      if (isReadOnly) {
        return {
          status,
          responseBody: body,
          httpStatus: response.status,
          errorDetail: null,
          invocationId: null,
        };
      }

      return this.persist(
        request,
        finalParams,
        idempotencyKey!,
        status,
        body,
        response.status,
        null,
      );
    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      const errorDetail = isTimeout
        ? 'Timeout al invocar la tool'
        : err.message;

      if (isReadOnly) {
        return {
          status: ToolInvocationStatus.TECHNICAL_ERROR,
          responseBody: null,
          httpStatus: null,
          errorDetail,
          invocationId: null,
        };
      }
      return this.persist(
        request,
        finalParams,
        idempotencyKey!,
        ToolInvocationStatus.TECHNICAL_ERROR,
        null,
        null,
        isTimeout ? 'Timeout al invocar la tool' : err.message,
      );
    }
  }

  /**
   * Hasta 3 intentos con la MISMA clave de idempotencia (seguro: el backend
   * deduplica). Se reintenta ante un timeout/red caída o si el backend
   * avisa que la misma operación sigue en curso. Así un bache momentáneo
   * no se convierte en "tuvimos un inconveniente" para el cliente.
   */
  private async callWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<{ response: Response; body: any }> {
    const MAX_ATTEMPTS = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);

        const inProgress =
          response.status === 409 && body?.code === 'IDEMPOTENCY_IN_PROGRESS';
        if (inProgress && attempt < MAX_ATTEMPTS) {
          await this.sleep(1500 * attempt);
          continue;
        }
        return { response, body };
      } catch (error) {
        lastError = error;
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(1000 * attempt);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private computeIdempotencyKey(
    request: ToolCallRequest,
    finalParams: Record<string, unknown>,
  ): string {
    // canonicalJson ordena también los campos anidados: antes solo se
    // consideraban las claves de primer nivel y "client.*" no influía.
    const normalized = canonicalJson(this.redactImageFields(finalParams));
    return createHash('sha256')
      .update(
        `${request.toolDefinitionId}:${request.conversationId}:${request.turnId ?? ''}:${normalized}`,
      )
      .digest('hex');
  }

  private buildUrlWithQuery(
    baseUrl: string,
    params: Record<string, unknown>,
  ): string {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && value.startsWith('data:image/'))
        continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
  private redactImageFields(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.startsWith('data:image/')) {
        redacted[key] = `[imagen omitida, ${value.length} caracteres]`;
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  private async persist(
    request: ToolCallRequest,
    finalParams: Record<string, unknown>,
    idempotencyKey: string,
    status: ToolInvocationStatus,
    responseBody: unknown,
    httpStatus: number | null,
    errorDetail: string | null,
  ): Promise<ToolCallOutcome> {
    // La llamada HTTP ya ocurrió (el backend deduplica con la misma clave):
    // se registra el resultado más reciente. Devolver el registro viejo
    // reportaba al modelo un timeout anterior aunque el reintento hubiera
    // funcionado.
    const data = {
      status,
      responseBody: responseBody as any,
      httpStatus,
      errorDetail,
    };
    const record = await this.prisma.toolInvocation.upsert({
      where: { idempotencyKey },
      create: {
        toolDefinitionId: request.toolDefinitionId,
        conversationId: request.conversationId,
        idempotencyKey,
        requestParams: this.redactImageFields(finalParams) as any,
        ...data,
      },
      update: data,
    });

    return {
      status,
      responseBody,
      httpStatus,
      errorDetail,
      invocationId: record.id,
    };
  }

  private fail(
    idempotencyKey: string | null,
    status: ToolInvocationStatus,
    responseBody: unknown,
    httpStatus: number | null,
    errorDetail: string,
  ): ToolCallOutcome {
    return {
      status,
      responseBody,
      httpStatus,
      errorDetail,
      invocationId: null,
    };
  }
}
