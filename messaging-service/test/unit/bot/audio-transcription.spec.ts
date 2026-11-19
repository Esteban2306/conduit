import { BadRequestException } from '@nestjs/common';
import {
  AudioTranscriptionService,
  transcribedContent,
} from 'src/bot/ai/AudioTranscriptionService';
import { AiModelController } from 'src/bot/ai/AiModel.controller';
import { BotConfigService } from 'src/bot/config/BotConfigService';

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

describe('Reactivar un modelo de audios', () => {
  const whisper = {
    id: 'tr-1',
    provider: 'GROQ',
    model: 'whisper-large-v3-turbo',
    baseUrl: null,
    role: 'TRANSCRIPTION',
  };

  function reactivate(status: number) {
    const { service, selector, fetchMock } = build({ response: { status } });
    const orchestrator = { probe: jest.fn() };
    const prisma = {
      aiModelConfig: {
        findUniqueOrThrow: jest.fn(() => Promise.resolve(whisper)),
      },
    };
    const controller = new AiModelController(
      { resetModelCounters: jest.fn(() => Promise.resolve()) } as never,
      orchestrator as never,
      prisma as never,
      service,
    );
    return {
      run: () =>
        controller.reactivate('bot', 'tr-1', { tenantId: 't' } as never),
      orchestrator,
      selector,
      fetchMock,
    };
  }

  it('confirma con la lista de modelos del proveedor, nunca con una conversación', async () => {
    const { run, orchestrator, fetchMock } = reactivate(200);
    expect((await run()).reactivation).toEqual({ ok: true });
    expect(orchestrator.probe).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://api.groq.com/openai/v1/models/whisper-large-v3-turbo',
    );
    expect(init.body).toBeUndefined();
  });

  it('una clave rechazada queda inválida y lo dice', async () => {
    const { run, selector } = reactivate(401);
    expect((await run()).reactivation).toMatchObject({
      ok: false,
      errorType: 'AUTHENTICATION',
    });
    expect(selector.markCredentialInvalid).toHaveBeenCalledWith(
      'tr-1',
      'AUTHENTICATION',
    );
  });

  it('un modelo que el proveedor no tiene se explica', async () => {
    const { run } = reactivate(404);
    expect((await run()).reactivation).toMatchObject({
      ok: false,
      message: 'El proveedor no tiene el modelo whisper-large-v3-turbo.',
    });
  });
});

describe('Agregar un modelo de audios', () => {
  function add(provider: string, baseUrl?: string) {
    const create = jest.fn(() => Promise.resolve({ id: 'x' }));
    const service = new BotConfigService(
      { aiModelConfig: { create } } as never,
      {} as never,
      { seal: (v: string) => v, last4: () => '1234' } as never,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
    return {
      create,
      run: () =>
        service.addAiModel(
          'bot',
          {
            provider,
            model: 'whisper-large-v3-turbo',
            apiKey: 'gsk_test_1234567890',
            role: 'TRANSCRIPTION',
            tier: 'FREE',
            priority: 1,
            baseUrl,
          } as never,
          't',
        ),
    };
  }

  it('con Groq basta el modelo y la clave', async () => {
    const { run, create } = add('GROQ');
    await run();
    expect(create).toHaveBeenCalled();
  });

  it('un proveedor sin transcripción compatible se rechaza antes de guardar', async () => {
    const { run, create } = add('ANTHROPIC');
    await expect(run()).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
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
