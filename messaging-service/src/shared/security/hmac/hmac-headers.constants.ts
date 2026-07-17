export const HMAC_HEADERS = {
  INTEGRATION_ID: 'x-conduit-integration-id',
  TIMESTAMP: 'x-conduit-timestamp',
  SIGNATURE: 'x-conduit-signature',
} as const;

export const HMAC_DEFAULT_WINDOW_SECONDS = 300;
