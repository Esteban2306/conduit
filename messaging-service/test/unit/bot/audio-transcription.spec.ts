jest.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: jest.fn(),
}));

import {
  AudioTranscriptionService,
  transcribedContent,
} from 'src/bot/ai/AudioTranscriptionService';

const audioMessage = (seconds: number) =>
  ({
    key: { id: 'm1' },
    message: { audioMessage: { seconds, mimetype: 'audio/ogg; codecs=opus' } },
  }) as never;

function build(options: {
  model?: Record<string, unknown> | null;
  response?: { status: number; body?: unknown };
}) {
  const selector = {
    selectModel: jest.fn(() =>
      Promise.resolve(
        options.model === undefined
          ? {
              id: 'tr-1',
              provider: 'GROQ',
              model: 'whisper-large-v3-turbo',
              baseUrl: null,
            }
          : options.model,
      ),
    ),
    resolveApiKey: jest.fn(() => Promise.resolve('gsk_test')),
    recordSuccess: jest.fn(() => Promise.resolve()),
    recordFailure: jest.fn(() =>
      Promise.resolve({ failures: 1, openUntil: null }),
    ),
    markCredentialInvalid: jest.fn(() => Promise.resolve(true)),
  };
  const service = new AudioTranscriptionService(
    selector as never,
    { get: () => undefined } as never,
  );
  service.useDownloader(() => Promise.resolve(Buffer.from('ogg-bytes')));
  (service as unknown as { logger: object }).logger = {
    warn: jest.fn(),
    error: jest.fn(),
  };
  const response = options.response ?? {
    status: 200,
    body: { text: ' Hola, quiero una cita para el viernes ' },
  };
  const fetchMock = jest.fn(() =>
    Promise.resolve({
      ok: response.status < 400,
      status: response.status,
      json: () => Promise.resolve(response.body ?? {}),
    } as Response),
  );
  global.fetch = fetchMock as never;
  return { service, selector, fetchMock };
}

describe('AudioTranscriptionService', () => {
  it('transcribe con Groq Whisper en español y devuelve el texto limpio', async () => {
    const { service, fetchMock, selector } = build({});
    const out = await service.transcribe(audioMessage(8), 'bot-1');
    expect(out).toEqual({
      kind: 'TEXT',
      text: 'Hola, quiero una cita para el viernes',
      seconds: 8,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('language')).toBe('es');
    expect(selector.recordSuccess).toHaveBeenCalled();
  });

  it('un audio de más de 2 minutos no se transcribe ni se descarga', async () => {
    const { service, fetchMock } = build({});
    expect(await service.transcribe(audioMessage(150), 'bot-1')).toEqual({
      kind: 'TOO_LONG',
      seconds: 150,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin modelo de transcripción configurado no llama a nadie', async () => {
    const { service, fetchMock } = build({ model: null });
    expect(await service.transcribe(audioMessage(5), 'bot-1')).toEqual({
      kind: 'UNAVAILABLE',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('una clave rechazada deja el modelo fuera de uso y no inventa texto', async () => {
    const { service, selector } = build({ response: { status: 401 } });
    expect(await service.transcribe(audioMessage(5), 'bot-1')).toEqual({
      kind: 'FAILED',
    });
    expect(selector.markCredentialInvalid).toHaveBeenCalledWith(
      'tr-1',
      'AUTHENTICATION',
    );
  });

  it('un error del proveedor cuenta como fallo del modelo', async () => {
    const { service, selector } = build({ response: { status: 503 } });
    expect((await service.transcribe(audioMessage(5), 'bot-1')).kind).toBe(
      'FAILED',
    );
    expect(selector.recordFailure).toHaveBeenCalledWith('tr-1', 'SERVER_ERROR');
  });
});

describe('transcribedContent', () => {
  it('lo que ve el bot según el resultado', () => {
    expect(transcribedContent({ kind: 'TEXT', text: 'Hola', seconds: 3 })).toBe(
      '[audio transcrito] Hola',
    );
    expect(transcribedContent({ kind: 'TOO_LONG', seconds: 300 })).toBe(
      '[audio de 5 min, demasiado largo para escucharlo]',
    );
    expect(transcribedContent({ kind: 'FAILED' })).toBe('[audio]');
    expect(transcribedContent({ kind: 'UNAVAILABLE' })).toBe('[audio]');
  });
});
