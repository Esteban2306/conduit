export enum ErrorType {
  TRANSIENT = 'TRANSIENT',
  PERMANENT = 'PERMANENT',
}

export interface ClassifiedError {
  type: ErrorType;
  errorCode: string;
  retryable: boolean;
  reason: string;
}

const PERMANENT_ERROR_CODES = new Set([
  'INVALID_RECIPIENT',
  'NO_WHATSAPP_ACCOUNT',
  'PERMANENT_DELIVERY_FAILURE',
  'TEMPLATE_NOT_FOUND',
  'TEMPLATE_RENDER_FAILED',
  'INVALID_PAYLOAD',
]);

const TRANSIENT_ERROR_CODES = new Set([
  'WHATSAPP_NOT_CONNECTED',
  'CONNECTION_ERROR',
  'NETWORK_ERROR',
  'RATE_LIMIT',
  'TIMEOUT',
]);

export class ErrorClassifier {
  static classify(errorCode: string, retryable: boolean): ClassifiedError {
    if (retryable === false || PERMANENT_ERROR_CODES.has(errorCode)) {
      return {
        type: ErrorType.PERMANENT,
        errorCode,
        retryable: false,
        reason: `Error permanente: ${errorCode}. No se reintentará.`,
      };
    }
    if (retryable === true || TRANSIENT_ERROR_CODES.has(errorCode)) {
      return {
        type: ErrorType.TRANSIENT,
        errorCode,
        retryable: true,
        reason: `Error transitorio: ${errorCode}. Será reintentado.`,
      };
    }
    return {
      type: ErrorType.TRANSIENT,
      errorCode: errorCode || 'UNKNOWN_ERROR',
      retryable: true,
      reason: `Error transitorio: ${errorCode}. Será reintentado.`,
    };
  }

  static isPermanent(errorCode: string): boolean {
    return PERMANENT_ERROR_CODES.has(errorCode);
  }

  static isTransient(errorCode: string): boolean {
    return TRANSIENT_ERROR_CODES.has(errorCode);
  }
}
