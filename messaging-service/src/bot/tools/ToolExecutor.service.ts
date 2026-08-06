import { Injectable, Logger } from '@nestjs/common';
import { ToolInvocationStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from 'src/shared/prisma.service';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';

export interface ToolCallRequest {
  toolDefinitionId: string;
  conversationId: string;
  params: Record<string, unknown>;
}

export interface ToolCallOutcome {
  status: ToolInvocationStatus;
  responseBody: unknown;
  httpStatus: number | null;
  errorDetail: string | null;
  invocationId: string;
}

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  private readonly TIMEOUT_MS = 10_000;

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
        request,
        this.computeIdempotencyKey(request),
        ToolInvocationStatus.TECHNICAL_ERROR,
        null,
        null,
        'Tool no encontrada o inactiva',
      );
    }

    const idempotencyKey = this.computeIdempotencyKey(request);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (tool.authHeaderName && tool.authSecretEncrypted) {
      headers[tool.authHeaderName] = this.encryption.decrypt(
        tool.authSecretEncrypted,
      );
    }
    headers['X-Conduit-Idempotency-Key'] = idempotencyKey;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

      const response = await fetch(tool.endpointUrl, {
        method: tool.httpMethod,
        headers,
        body: JSON.stringify(request.params),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      const body = await response.json().catch(() => null);

      const status = response.ok
        ? ToolInvocationStatus.SUCCESS
        : response.status >= 400 && response.status < 500
          ? ToolInvocationStatus.BUSINESS_ERROR
          : ToolInvocationStatus.TECHNICAL_ERROR;

      return this.persist(
        request,
        idempotencyKey,
        status,
        body,
        response.status,
        null,
      );
    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      return this.persist(
        request,
        idempotencyKey,
        ToolInvocationStatus.TECHNICAL_ERROR,
        null,
        null,
        isTimeout ? 'Timeout al invocar la tool' : err.message,
      );
    }
  }

  private computeIdempotencyKey(request: ToolCallRequest): string {
    const normalizedParams = JSON.stringify(
      request.params,
      Object.keys(request.params).sort(),
    );
    return createHash('sha256')
      .update(
        `${request.toolDefinitionId}:${request.conversationId}:${normalizedParams}`,
      )
      .digest('hex');
  }

  private async persist(
    request: ToolCallRequest,
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
        `Reintento detectado para idempotencyKey ${idempotencyKey} — reutilizando invocación ${existing.id} sin duplicar.`,
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
        requestParams: request.params as any,
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
    request: ToolCallRequest,
    idempotencyKey: string,
    status: ToolInvocationStatus,
    responseBody: unknown,
    httpStatus: number | null,
    errorDetail: string,
  ): Promise<ToolCallOutcome> {
    return this.persist(
      request,
      idempotencyKey,
      status,
      responseBody,
      httpStatus,
      errorDetail,
    );
  }
}
