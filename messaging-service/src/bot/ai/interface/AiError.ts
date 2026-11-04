export enum AiErrorType {
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  RATE_LIMIT = 'RATE_LIMIT',
  INVALID_REQUEST = 'INVALID_REQUEST',
  SERVER_ERROR = 'SERVER_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

export enum AiErrorAction {
  FALLBACK = 'FALLBACK',
  RETRY = 'RETRY',
  DISABLE_TEMPORARILY = 'DISABLE_TEMPORARILY',
  DISABLE = 'DISABLE',
  ABORT = 'ABORT',
}

export interface ClassifiedAiError {
  type: AiErrorType;
  action: AiErrorAction;
  statusCode?: number;
  retryAfterMs?: number;
  message: string;
  originalError: unknown;
}
