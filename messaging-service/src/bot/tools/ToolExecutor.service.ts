import { Injectable, Logger } from '@nestjs/common';
import { ToolInvocationStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from 'src/shared/prisma.service';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';

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
      finalParams[request.phoneParamName] = request.injectedPhone;
    }

    const method = (tool.httpMethod ?? 'POST').toUpperCase();
    const isReadOnly = READ_ONLY_METHODS.has(method);

    const headers: Record<string, string> = {};
    if (!isReadOnly) headers['Content-Type'] = 'application/json';

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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const requestUrl = isReadOnly
        ? this.buildUrlWithQuery(tool.endpointUrl, finalParams)
        : tool.endpointUrl;

      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (!isReadOnly) {
        fetchOptions.body = JSON.stringify(finalParams);
      }

      const response = await fetch(requestUrl, fetchOptions).finally(() =>
        clearTimeout(timeout),
      );

      const body = await response.json().catch(() => null);

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

  private computeIdempotencyKey(
    request: ToolCallRequest,
    finalParams: Record<string, unknown>,
  ): string {
    const paramsForHash = this.redactImageFields(finalParams);
    const normalized = JSON.stringify(
      paramsForHash,
      Object.keys(paramsForHash).sort(),
    );
    return createHash('sha256')
      .update(
        `${request.toolDefinitionId}:${request.conversationId}:${normalized}`,
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
    const existing = await this.prisma.toolInvocation.findUnique({
      where: { idempotencyKey },
    });

    if (existing) {
      this.logger.debug(
        `Reintento detectado para idempotencyKey ${idempotencyKey} — reutilizando invocación ${existing.id}.`,
      );
      return {
        status: existing.status,
        responseBody: existing.responseBody,
        httpStatus: existing.httpStatus,
        errorDetail: existing.errorDetail,
        invocationId: existing.id,
      };
    }

    const record = await this.prisma.toolInvocation.create({
      data: {
        toolDefinitionId: request.toolDefinitionId,
        conversationId: request.conversationId,
        idempotencyKey,
        requestParams: this.redactImageFields(finalParams) as any,
        status,
        responseBody: responseBody as any,
        httpStatus,
        errorDetail,
      },
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
