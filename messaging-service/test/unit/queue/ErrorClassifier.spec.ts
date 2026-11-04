import { ErrorClassifier, ErrorType } from 'src/core/errors/ErrorClassifier';

describe('ErrorClassifier', () => {
  describe('classify()', () => {
    it('deberia clasificar como PERMANENT cuando retryable es false', () => {
      const result = ErrorClassifier.classify('CUALQUIER_CODIGO', false);

      expect(result.type).toBe(ErrorType.PERMANENT);
      expect(result.retryable).toBe(false);
    });

    it('deberia clasificar como PERMANENT para INVALID_RECIPIENT sin importar retryable', () => {
      const result = ErrorClassifier.classify('INVALID_RECIPIENT', true);

      expect(result.type).toBe(ErrorType.PERMANENT);
      expect(result.retryable).toBe(false);
    });

    it('deberia mostrar como permanente para NO_WHTASPP_ACOUNT', () => {
      const result = ErrorClassifier.classify('NO_WHATSAPP_ACOUNT', false);

      expect(result.type).toBe(ErrorType.PERMANENT);
      expect(result.retryable).toBe(false);
    });

    it('deberia marcar como TRANSIENT para WHATSAPP_NO_CONNECT', () => {
      const result = ErrorClassifier.classify('WHATSAPP_NO_CONNECT', true);

      expect(result.type).toBe(ErrorType.TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it('deberia marcar como TRANSIENT para NETWORK_ERROR', () => {
      const result = ErrorClassifier.classify('NETWORK_ERROR', true);

      expect(result.type).toBe(ErrorType.TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it('deberia marcar como TRANSIENT para errores desconocidos por si acaso', () => {
      const result = ErrorClassifier.classify('CODIGO_INEXISTENTE', true);

      expect(result.type).toBe(ErrorType.TRANSIENT);
      expect(result.retryable).toBe(true);
      expect(result.errorCode).toBe('CODIGO_INEXISTENTE');
    });

    it('deberia mostrar siempre el codigo de error', () => {
      const result = ErrorClassifier.classify('MI_CODIGO', true);

      expect(result.errorCode).toBe('MI_CODIGO');
      expect(result.reason).toBeDefined();
    });
  });

  describe('isPermanent()', () => {
    it('deberia devolver true para errores conocidos', () => {
      expect(ErrorClassifier.isPermanent('INVALID_RECIPIENT')).toBe(true);
      expect(ErrorClassifier.isPermanent('NO_WHATSAPP_ACCOUNT')).toBe(true);
      expect(ErrorClassifier.isPermanent('PERMANENT_DELIVERY_FAILURE')).toBe(
        true,
      );
    });

    it('deberia devolver false para codigos transitorios', () => {
      expect(ErrorClassifier.isPermanent('NETWORK_ERROR')).toBe(false);
      expect(ErrorClassifier.isPermanent('RATE_LIMIT')).toBe(false);
    });
  });
});
