import { Injectable } from '@nestjs/common';
import {
  AiErrorAction,
  AiErrorType,
  ClassifiedAiError,
} from './interface/AiError';

@Injectable()
export class AiErrorClassifier {
  classify(error: unknown): ClassifiedAiError {
    const statusCode = this.extractStatusCode(error);
    const message = this.extractMessage(error);

    switch (statusCode) {
      case 401:
        return this.createError(
          AiErrorType.AUTHENTICATION,
          AiErrorAction.DISABLE,
          error,
          message,
          statusCode,
        );
      case 403:
        return this.createError(
          AiErrorType.AUTHORIZATION,
          AiErrorAction.DISABLE,
          error,
          message,
          statusCode,
        );
      case 429:
        return this.createError(
          AiErrorType.RATE_LIMIT,
          AiErrorAction.DISABLE_TEMPORARILY,
          error,
          message,
          statusCode,
          this.extractRetryAfter(error),
        );
      case 400:
      case 422:
        return this.createError(
          AiErrorType.INVALID_REQUEST,
          AiErrorAction.ABORT,
          error,
          message,
          statusCode,
        );
      default:
        break;
    }
    if (statusCode !== undefined && statusCode >= 500) {
      return this.createError(
        AiErrorType.SERVER_ERROR,
        AiErrorAction.FALLBACK,
        error,
        message,
        statusCode,
      );
    }

    if (this.isTimeout(error)) {
      return this.createError(
        AiErrorType.TIMEOUT,
        AiErrorAction.FALLBACK,
        error,
        message,
      );
    }

    if (this.isNetworkError(error)) {
      return this.createError(
        AiErrorType.NETWORK_ERROR,
        AiErrorAction.FALLBACK,
        error,
        message,
      );
    }

    return this.createError(
      AiErrorType.UNKNOWN,
      AiErrorAction.FALLBACK,
      error,
      message,
      statusCode,
    );
  }

  private extractStatusCode(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;

    const candidate = error as {
      statusCode?: unknown;
      status?: unknown;
      response?: {
        status?: unknown;
        statusCode?: unknown;
      };
      cause?: {
        statusCode?: unknown;
        status?: unknown;
      };
    };

    const values = [
      candidate.statusCode,
      candidate.status,
      candidate.response?.status,
      candidate.response?.statusCode,
      candidate.cause?.statusCode,
      candidate.cause?.status,
    ];

    for (const value of values) {
      if (typeof value === 'number') {
        return value;
      }

      if (typeof value === 'string' && /^\d+$/.test(value)) {
        return Number(value);
      }
    }

    return undefined;
  }

  private extractMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'object' && error !== null) {
      const candidate = error as {
        message?: unknown;
        response?: {
          data?: {
            message?: unknown;
          };
        };
      };

      if (typeof candidate.message === 'string') {
        return candidate.message;
      }

      if (typeof candidate.response?.data?.message === 'string') {
        return candidate.response.data.message;
      }
    }

    return String(error);
  }

  private extractRetryAfter(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;

    const candidate = error as {
      response?: {
        headers?: Record<string, string | string[] | undefined>;
      };
      headers?: Record<string, string | string[] | undefined>;
    };

    const headers = candidate.response?.headers ?? candidate.headers;

    if (!headers) return undefined;

    const value = headers['retry-after'];

    if (!value) return undefined;

    const raw = Array.isArray(value) ? value[0] : value;
    const seconds = Number(raw);

    if (!Number.isNaN(seconds)) {
      return seconds * 1000;
    }

    return undefined;
  }

  private isTimeout(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const candidate = error as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
    };

    return (
      candidate.code === 'ETIMEDOUT' ||
      candidate.code === 'ECONNABORTED' ||
      candidate.name === 'TimeoutError' ||
      (typeof candidate.message === 'string' &&
        candidate.message.toLowerCase().includes('timeout'))
    );
  }

  private isNetworkError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const candidate = error as {
      code?: unknown;
    };

    return (
      candidate.code === 'ECONNRESET' ||
      candidate.code === 'ECONNREFUSED' ||
      candidate.code === 'ENOTFOUND' ||
      candidate.code === 'EAI_AGAIN'
    );
  }

  private createError(
    type: AiErrorType,
    action: AiErrorAction,
    originalError: unknown,
    message: string,
    statusCode?: number,
    retryAfterMs?: number,
  ): ClassifiedAiError {
    return {
      type,
      action,
      originalError,
      message,
      statusCode,
      retryAfterMs,
    };
  }
}
