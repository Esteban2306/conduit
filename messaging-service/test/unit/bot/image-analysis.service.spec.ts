jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  downloadMediaMessage: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));
const mockOptimize = jest.fn();
jest.mock('src/bot/helper/ImageOptimizer', () => ({
  ImageOptimizer: {
    optimize: (...args: unknown[]) => mockOptimize(...args) as unknown,
  },
}));

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { randomBytes } from 'crypto';
import { ImageAnalysisService } from 'src/bot/ai/ImageAnalysisService';

const download = downloadMediaMessage as jest.Mock;
const optimize = mockOptimize;

const original = randomBytes(2048);
const optimized = randomBytes(512);

function build(options: { model?: boolean } = {}) {
  const orchestrator = { analyzeImage: jest.fn() };
  const selector = {
    selectModel: jest
      .fn()
      .mockResolvedValue(
        options.model === false ? null : { provider: 'ANTHROPIC', model: 'm' },
      ),
  };
  const promptEngine = {
    buildImagePrompt: jest.fn().mockResolvedValue({
      systemPrompt: 'PROMPT DE IMAGEN',
      maxTokens: 250,
      temperature: 0.1,
    }),
  };
  const service = new ImageAnalysisService(
    orchestrator as never,
    {} as never,
    selector as never,
    promptEngine as never,
  );
  (service as unknown as { logger: object }).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { service, orchestrator, selector, promptEngine };
}

const analyze = (service: ImageAnalysisService) =>
  service.analyzeFromMessage({} as never, 'bot-1', 'sistema');

describe('ImageAnalysisService (red de seguridad de la fase 3c)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    download.mockResolvedValue(original);
    optimize.mockResolvedValue(optimized);
  });

  describe('descarga y preparación', () => {
    it('si la descarga falla devuelve ANALYSIS_ERROR sin llamar al modelo', async () => {
      download.mockRejectedValue(new Error('sin red'));
      const { service, orchestrator } = build();

      const result = await analyze(service);

      expect(result).toMatchObject({
        status: 'ANALYSIS_ERROR',
        valid: false,
        confidence: 'LOW',
        details: 'No se pudo descargar la imagen',
      });
      expect(orchestrator.analyzeImage).not.toHaveBeenCalled();
    });

    it('optimiza la imagen y manda al modelo la versión optimizada como JPEG', async () => {
      const { service, orchestrator } = build();
      orchestrator.analyzeImage.mockResolvedValue({
        content: '{"valid":true,"confidence":"HIGH","details":"ok"}',
      });

      await analyze(service);

      expect(optimize).toHaveBeenCalledWith(original);
      expect(orchestrator.analyzeImage).toHaveBeenCalledWith({
        botConfigId: 'bot-1',
        systemPrompt: 'PROMPT DE IMAGEN',
        prompt: 'PROMPT DE IMAGEN',
        imageBuffer: optimized,
        mimeType: 'image/jpeg',
      });
    });

    it('el prompt sale del motor de prompts del bot', async () => {
      const { service, orchestrator, promptEngine } = build();
      orchestrator.analyzeImage.mockResolvedValue({ content: '{}' });

      await analyze(service);

      expect(promptEngine.buildImagePrompt).toHaveBeenCalledWith('bot-1');
    });
  });

  describe('interpretación de la respuesta del modelo', () => {
    const respond = async (content: string) => {
      const { service, orchestrator } = build();
      orchestrator.analyzeImage.mockResolvedValue({ content });
      return analyze(service);
    };

    it('lee un JSON válido', async () => {
      expect(
        await respond(
          '{"valid":true,"confidence":"HIGH","details":"comprobante claro"}',
        ),
      ).toMatchObject({
        status: 'SUCCESS',
        valid: true,
        confidence: 'HIGH',
        details: 'comprobante claro',
      });
    });

    it('acepta el JSON dentro de un bloque de código', async () => {
      expect(
        await respond(
          '```json\n{"valid":false,"confidence":"LOW","details":"borrosa"}\n```',
        ),
      ).toMatchObject({ status: 'SUCCESS', valid: false, confidence: 'LOW' });
    });

    it('sin confianza en el JSON usa MEDIUM', async () => {
      expect(await respond('{"valid":true}')).toMatchObject({
        valid: true,
        confidence: 'MEDIUM',
      });
    });

    it('un valid que no es booleano se convierte a booleano', async () => {
      expect(await respond('{"valid":"si"}')).toMatchObject({ valid: true });
      expect(await respond('{"valid":0}')).toMatchObject({ valid: false });
    });

    it('DEFECTO CONOCIDO: un texto que no es JSON y suena positivo se acepta como válido', async () => {
      expect(
        await respond('La imagen es un comprobante válido.'),
      ).toMatchObject({ status: 'SUCCESS', valid: true, confidence: 'LOW' });
    });

    it('un texto que no es JSON y no suena positivo queda como no válido', async () => {
      expect(await respond('No logro leer nada')).toMatchObject({
        status: 'SUCCESS',
        valid: false,
        confidence: 'LOW',
      });
    });

    it('los detalles de un texto libre se recortan a 150 caracteres', async () => {
      const result = await respond('x'.repeat(400));
      expect(result.details).toHaveLength(150);
    });
  });

  describe('errores del proveedor', () => {
    const failWith = async (message: string) => {
      const { service, orchestrator } = build();
      orchestrator.analyzeImage.mockRejectedValue(new Error(message));
      return analyze(service);
    };

    it.each([
      '503 Service Unavailable',
      'Request failed: 429',
      'model under high demand',
      'Todos los modelos fallaron',
    ])('"%s" se informa como PROVIDER_UNAVAILABLE', async (message) => {
      expect((await failWith(message)).status).toBe('PROVIDER_UNAVAILABLE');
    });

    it('DEFECTO CONOCIDO: el mensaje real del orquestador cuando caen todos los modelos no coincide con el texto buscado y sale como ANALYSIS_ERROR', async () => {
      expect(
        (
          await failWith(
            'Todos los modelos disponibles fallaron. Último error: x',
          )
        ).status,
      ).toBe('ANALYSIS_ERROR');
    });

    it('cualquier otro error es ANALYSIS_ERROR', async () => {
      expect(await failWith('boom')).toMatchObject({
        status: 'ANALYSIS_ERROR',
        valid: false,
        confidence: 'LOW',
      });
    });
  });

  describe('sin modelo IMAGE_ANALYSIS configurado (clave por defecto)', () => {
    const KEY = 'OPENROUTER_API_KEY';
    const previous = process.env[KEY];
    const realFetch = global.fetch;

    afterEach(() => {
      if (previous === undefined) delete process.env[KEY];
      else process.env[KEY] = previous;
      global.fetch = realFetch;
    });

    it('sin la clave del entorno falla como ANALYSIS_ERROR y no llama a la red', async () => {
      delete process.env[KEY];
      global.fetch = jest.fn() as never;
      const { service, orchestrator } = build({ model: false });

      const result = await analyze(service);

      expect(result.status).toBe('ANALYSIS_ERROR');
      expect(global.fetch).not.toHaveBeenCalled();
      expect(orchestrator.analyzeImage).not.toHaveBeenCalled();
    });

    it('con la clave del entorno usa OpenRouter con esa clave', async () => {
      const fake = randomBytes(12).toString('hex');
      process.env[KEY] = fake;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: '{"valid":true,"confidence":"HIGH","details":"ok"}',
                },
              },
            ],
            usage: { total_tokens: 10 },
          }),
      }) as never;
      const { service } = build({ model: false });

      const result = await analyze(service);

      expect(result).toMatchObject({ status: 'SUCCESS', valid: true });
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
        string,
        { headers: Record<string, string> },
      ];
      expect(url).toContain('openrouter.ai');
      expect(init.headers.Authorization).toBe(`Bearer ${fake}`);
    });

    it('un 503 de OpenRouter se informa como PROVIDER_UNAVAILABLE', async () => {
      process.env[KEY] = randomBytes(12).toString('hex');
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('saturado'),
      }) as never;
      const { service } = build({ model: false });

      expect((await analyze(service)).status).toBe('PROVIDER_UNAVAILABLE');
    });
  });
});
