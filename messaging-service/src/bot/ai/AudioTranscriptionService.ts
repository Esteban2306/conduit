import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModelRole, AiProvider } from '@prisma/client';
import { downloadMediaMessage, WAMessage } from '@whiskeysockets/baileys';
import { maskError } from 'src/shared/security/mask-secrets';
import { AiModelSelectorService } from './AiModelSelectorService';
import { AiErrorType } from './interface/AiError';

export type TranscriptionResult =
  | { kind: 'TEXT'; text: string; seconds: number | null }
  | { kind: 'TOO_LONG'; seconds: number }
  | { kind: 'UNAVAILABLE' }
  | { kind: 'FAILED' };

export const DEFAULT_MAX_AUDIO_SECONDS = 120;
const TRANSCRIPTION_TIMEOUT_MS = 25_000;
const MAX_TRANSCRIPT_CHARS = 2000;

const OPENAI_COMPATIBLE_BASE: Partial<Record<AiProvider, string>> = {
  GROQ: 'https://api.groq.com/openai/v1',
  OPENAI: 'https://api.openai.com/v1',
};

type Downloader = (message: WAMessage) => Promise<Buffer>;

@Injectable()
export class AudioTranscriptionService {
  private readonly logger = new Logger(AudioTranscriptionService.name);
  private download: Downloader = async (message) =>
    await downloadMediaMessage(message, 'buffer', {});

  constructor(
    private readonly selector: AiModelSelectorService,
    private readonly config: ConfigService,
  ) {}

  useDownloader(downloader: Downloader): void {
    this.download = downloader;
  }

  maxSeconds(): number {
    const configured = Number(this.config.get('audio.maxSeconds'));
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_AUDIO_SECONDS;
  }

  async transcribe(
    message: WAMessage,
    botConfigId: string,
    language = 'es',
  ): Promise<TranscriptionResult> {
    const audio = message.message?.audioMessage;
    if (!audio) return { kind: 'FAILED' };

    const seconds = Number(audio.seconds ?? 0) || null;
    if (seconds !== null && seconds > this.maxSeconds()) {
      return { kind: 'TOO_LONG', seconds };
    }

    const model = await this.selector.selectModel(
      botConfigId,
      AiModelRole.TRANSCRIPTION,
    );
    const base = model
      ? (model.baseUrl ?? OPENAI_COMPATIBLE_BASE[model.provider])
      : undefined;
    if (!model || !base) return { kind: 'UNAVAILABLE' };

    try {
      const [buffer, apiKey] = await Promise.all([
        this.download(message),
        this.selector.resolveApiKey(model),
      ]);
      const mime = (audio.mimetype ?? 'audio/ogg').split(';')[0].trim();
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(buffer)], { type: mime }),
        `audio.${mime.includes('mp4') ? 'm4a' : 'ogg'}`,
      );
      form.append('model', model.model);
      form.append('language', language.slice(0, 2));
      form.append('response_format', 'json');
      form.append('temperature', '0');

      const res = await fetch(
        `${base.replace(/\/+$/, '')}/audio/transcriptions`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
        },
      );

      if (res.status === 401 || res.status === 403) {
        await this.selector.markCredentialInvalid(
          model.id,
          AiErrorType.AUTHENTICATION,
        );
        this.logger.error(
          `La clave de transcripción (${model.provider}/${model.model}) fue rechazada.`,
        );
        return { kind: 'FAILED' };
      }
      if (!res.ok) {
        await this.selector.recordFailure(
          model.id,
          res.status === 429
            ? AiErrorType.RATE_LIMIT
            : res.status >= 500
              ? AiErrorType.SERVER_ERROR
              : AiErrorType.INVALID_REQUEST,
        );
        this.logger.warn(
          `La transcripción respondió ${res.status} (${model.provider}/${model.model}).`,
        );
        return { kind: 'FAILED' };
      }

      const body = (await res.json()) as { text?: unknown };
      const text =
        typeof body.text === 'string'
          ? body.text.trim().slice(0, MAX_TRANSCRIPT_CHARS)
          : '';
      await this.selector.recordSuccess(model);
      return text ? { kind: 'TEXT', text, seconds } : { kind: 'FAILED' };
    } catch (error) {
      await this.selector
        .recordFailure(
          model.id,
          error instanceof Error && error.name === 'TimeoutError'
            ? AiErrorType.TIMEOUT
            : AiErrorType.NETWORK_ERROR,
        )
        .catch(() => undefined);
      this.logger.warn(`No se pudo transcribir el audio: ${maskError(error)}`);
      return { kind: 'FAILED' };
    }
  }
}

export function transcribedContent(result: TranscriptionResult): string {
  switch (result.kind) {
    case 'TEXT':
      return `[audio transcrito] ${result.text}`;
    case 'TOO_LONG':
      return `[audio de ${Math.round(result.seconds / 60)} min, demasiado largo para escucharlo]`;
    default:
      return '[audio]';
  }
}
