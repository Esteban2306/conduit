import {
  backoffMs,
  OUTBOX_MAX_ATTEMPTS,
  OVERLIMIT_RETRY_MS,
  verdictFor,
} from 'src/channels/whatsapp/outbox/outbox-policy';

describe('outbox-policy', () => {
  it('éxito, canal caído y fallos definitivos', () => {
    expect(verdictFor({ success: true }, 1)).toEqual({ action: 'sent' });
    expect(
      verdictFor(
        {
          success: false,
          retryable: true,
          errorCode: 'WHATSAPP_NOT_CONNECTED',
        },
        99,
      ),
    ).toMatchObject({ action: 'wait' });
    expect(
      verdictFor(
        { success: false, retryable: false, errorCode: 'SEND_FAILED' },
        1,
      ),
    ).toEqual({ action: 'fail' });
  });

  it('la espera crece con los intentos y se agotan', () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(3));
    expect(backoffMs(50)).toBe(backoffMs(5));
    const transient = {
      success: false,
      retryable: true,
      errorCode: 'CONNECTION_ERROR',
    };
    expect(verdictFor(transient, OUTBOX_MAX_ATTEMPTS - 1)).toMatchObject({
      action: 'retry',
    });
    expect(verdictFor(transient, OUTBOX_MAX_ATTEMPTS)).toEqual({
      action: 'fail',
    });
  });

  it('un rate-overlimit de WhatsApp espera al menos 2 minutos', () => {
    const verdict = verdictFor(
      { success: false, retryable: true, errorCode: 'RATE_OVERLIMIT' },
      1,
    );
    expect(verdict).toEqual({ action: 'retry', delayMs: OVERLIMIT_RETRY_MS });
  });
});
