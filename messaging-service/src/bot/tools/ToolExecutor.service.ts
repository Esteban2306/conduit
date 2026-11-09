import { Injectable, Logger } from '@nestjs/common';
import { ToolInvocationStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from 'src/shared/prisma.service';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { canonicalJson, setByPath } from './json-path.util';
import { createHmac } from 'crypto';
import { extractedFieldsSchema } from '../specialists/contracts';
import { hashImage, NORMALIZED_HASH_VERSION } from '../specialists/image-hash';
import {
  AcceptableRecord,
  VerificationLedger,
} from '../specialists/VerificationLedger';
import { TOOL_READ_TIMEOUT_MS, TOOL_WRITE_TIMEOUT_MS } from '../ai/turn-budget';

/**
 * Headers con la identidad verificada del chat. Los pone Conduit (no el
 * modelo), así el backend puede imponerla y nadie puede, escribiéndole al
 * bot, operar sobre las reservas de otro número.
 */
export const CONTACT_PHONE_HEADER = 'X-Conduit-Contact-Phone';
export const CONTACT_LID_HEADER = 'X-Conduit-Contact-Lid';
export const CONVERSATION_HEADER = 'X-Conduit-Conversation-Id';
export const CORRELATION_HEADER = 'X-Correlation-Id';
export const VERIFICATION_HEADER = 'X-Conduit-Verification';
export const VERIFICATION_SIGNATURE_HEADER = 'X-Conduit-Verification-Signature';
export const VERIFICATION_REQUIRED = 'VERIFICATION_REQUIRED';
export const PASSPORT_VERSION = 1;

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
  /** Fin del presupuesto del turno (epoch ms): ningún intento lo excede. */
  deadlineAt?: number;
}

export interface ToolCallOutcome {
  status: ToolInvocationStatus;
  responseBody: unknown;
  httpStatus: number | null;
  errorDetail: string | null;
  invocationId: string | null;
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

interface Granted {
  recordId: string;
  tenantId: string;
  passport: Record<string, unknown>;
}

type Decision =
  | { ok: true; granted: Granted }
  | { ok: false; outcome: ToolCallOutcome };

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  private readonly IMAGE_TIMEOUT_MS = 25_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: SecretEncryptionService,
    private readonly ledger: VerificationLedger,
  ) {}

  async execute(request: ToolCallRequest): Promise<ToolCallOutcome> {
    const tool = await this.prisma.toolDefinition.findUnique({
      where: { id: request.toolDefinitionId },
      include: { botConfig: { select: { tenantId: true } } },
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

    let granted: Granted | null = null;
    if (tool.verificationCapability) {
      const decision = await this.authorize(tool, request);
      if (!decision.ok) return decision.outcome;
      granted = decision.granted;
    }

    const finalParams = { ...request.params };

    if (request.attachedImage && request.imageParamName) {
      finalParams[request.imageParamName] = request.attachedImage.dataUri;
    }
    let passportHeaders: Record<string, string> = {};
    if (granted && tool.authSecretEncrypted) {
      const signed = this.sign(
        granted.passport,
        this.encryption.decrypt(tool.authSecretEncrypted),
      );
      passportHeaders = {
        [VERIFICATION_HEADER]: signed.payload,
        [VERIFICATION_SIGNATURE_HEADER]: signed.signature,
      };
      if (tool.verificationParamName) {
        setByPath(finalParams, tool.verificationParamName, signed);
      }
    }
    if (request.injectedPhone && request.phoneParamName) {
      setByPath(finalParams, request.phoneParamName, request.injectedPhone);
    }

    const method = (tool.httpMethod ?? 'POST').toUpperCase();
    const isReadOnly = READ_ONLY_METHODS.has(method);

    const headers: Record<string, string> = {};
    if (!isReadOnly) headers['Content-Type'] = 'application/json';

    headers[CONVERSATION_HEADER] = request.conversationId;
    if (request.turnId) headers[CORRELATION_HEADER] = request.turnId;
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

    Object.assign(headers, passportHeaders);

    let idempotencyKey: string | null = null;
    if (!isReadOnly) {
      idempotencyKey = this.computeIdempotencyKey(request, finalParams);
      headers['X-Conduit-Idempotency-Key'] = idempotencyKey;
    }

    const timeoutMs = request.attachedImage
      ? this.IMAGE_TIMEOUT_MS
      : isReadOnly
        ? TOOL_READ_TIMEOUT_MS
        : TOOL_WRITE_TIMEOUT_MS;

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
        request.deadlineAt,
      );

      const status = response.ok
        ? ToolInvocationStatus.SUCCESS
        : response.status >= 400 && response.status < 500
          ? ToolInvocationStatus.BUSINESS_ERROR
          : ToolInvocationStatus.TECHNICAL_ERROR;

      if (granted && this.isDefinitiveRejection(response.status)) {
        await this.releaseQuietly(granted);
      }

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
   * Hasta 2 intentos con la MISMA clave de idempotencia (seguro: el backend
   * deduplica). Se reintenta ante un timeout/red caída o si el backend
   * avisa que la misma operación sigue en curso. Cada intento y cada espera
   * están limitados por lo que queda del presupuesto del turno.
   */
  private async callWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    deadlineAt?: number,
  ): Promise<{ response: Response; body: any }> {
    const MAX_ATTEMPTS = 2;
    const MIN_ATTEMPT_MS = 1_000;
    const left = () =>
      deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const budgetMs = Math.min(timeoutMs, left());
      if (budgetMs < MIN_ATTEMPT_MS && attempt > 1) break;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(budgetMs, MIN_ATTEMPT_MS),
      );
      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);

        const inProgress =
          response.status === 409 && body?.code === 'IDEMPOTENCY_IN_PROGRESS';
        if (inProgress && attempt < MAX_ATTEMPTS) {
          await this.sleep(Math.min(1500, Math.max(0, left() - 1_000)));
          continue;
        }
        return { response, body };
      } catch (error) {
        lastError = error;
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(Math.min(1000, Math.max(0, left() - 1_000)));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error('Timeout al invocar la tool');
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

  private async authorize(
    tool: {
      verificationCapability: string | null;
      acceptedVerdicts: string[] | null;
      authSecretEncrypted: string | null;
      botConfig: { tenantId: string };
    },
    request: ToolCallRequest,
  ): Promise<Decision> {
    const refuse = (detail: string): Decision => ({
      ok: false,
      outcome: {
        status: ToolInvocationStatus.BUSINESS_ERROR,
        responseBody: {
          code: VERIFICATION_REQUIRED,
          message:
            'Esta acción exige un comprobante con verificación aprobada, vigente y sin usar. Pídele a la clienta que envíe el comprobante en este chat o informa que una persona lo revisará.',
          nextStep: 'WAIT_FOR_REVIEW',
        },
        httpStatus: 422,
        errorDetail: detail,
        invocationId: null,
      },
    });

    if (!tool.authSecretEncrypted) {
      return {
        ok: false,
        outcome: {
          status: ToolInvocationStatus.TECHNICAL_ERROR,
          responseBody: null,
          httpStatus: null,
          errorDetail:
            'La herramienta exige verificación pero no tiene secreto para firmar el pasaporte.',
          invocationId: null,
        },
      };
    }

    const buffer = this.decodeImage(request.attachedImage?.dataUri);
    if (!buffer) return refuse('Sin imagen adjunta');

    const hash = await hashImage(buffer);
    if (hash.version !== NORMALIZED_HASH_VERSION) {
      return refuse('La imagen no se pudo normalizar');
    }

    const tenantId = tool.botConfig.tenantId;
    const record = await this.ledger.findAcceptable({
      tenantId,
      conversationId: request.conversationId,
      capability: tool.verificationCapability as string,
      hash: hash.hash,
      acceptedVerdicts: (tool.acceptedVerdicts ?? []) as never,
    });
    if (!record)
      return refuse('Sin veredicto aceptado y vigente para la imagen');

    if (!(await this.ledger.claim(record.id, tenantId))) {
      return refuse('El veredicto ya fue utilizado');
    }

    return {
      ok: true,
      granted: {
        recordId: record.id,
        tenantId,
        passport: this.passportOf(
          record,
          tenantId,
          request.conversationId,
          tool.verificationCapability as string,
        ),
      },
    };
  }

  private decodeImage(dataUri: string | undefined): Buffer | null {
    const match = /^data:[^;,]+;base64,(.+)$/s.exec(dataUri ?? '');
    if (!match) return null;
    const buffer = Buffer.from(match[1], 'base64');
    return buffer.length > 0 ? buffer : null;
  }

  private passportOf(
    record: AcceptableRecord,
    tenantId: string,
    conversationId: string,
    capability: string,
  ): Record<string, unknown> {
    const fields = extractedFieldsSchema.safeParse(record.fields);
    return {
      version: PASSPORT_VERSION,
      verificationId: record.id,
      capability,
      tenantId,
      conversationId,
      verdict: record.verdict,
      confidence: record.confidence,
      fields: fields.success ? fields.data : {},
      hash: record.subjectHash,
      issuedAt: record.createdAt.toISOString(),
      expiresAt: new Date(
        record.createdAt.getTime() + this.ledger.passportTtlMs(),
      ).toISOString(),
    };
  }

  private sign(
    passport: Record<string, unknown>,
    secret: string,
  ): { payload: string; signature: string } {
    const payload = Buffer.from(canonicalJson(passport)).toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    return { payload, signature };
  }

  private isDefinitiveRejection(httpStatus: number): boolean {
    return (
      httpStatus >= 400 &&
      httpStatus < 500 &&
      httpStatus !== 408 &&
      httpStatus !== 429
    );
  }

  private async releaseQuietly(granted: Granted): Promise<void> {
    try {
      await this.ledger.release(granted.recordId, granted.tenantId);
    } catch (error) {
      this.logger.error(
        `No se pudo liberar el veredicto ${granted.recordId} tras un rechazo del backend: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
