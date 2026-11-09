import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImagePrefetch, PrefetchTake } from './image-prefetch';

export const DEFAULT_SETTLE_MS = 1500;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10_000;

@Injectable()
export class ImagePrefetchService<T = unknown> {
  private readonly prefetch: ImagePrefetch<T>;

  constructor(private readonly config: ConfigService) {
    this.prefetch = new ImagePrefetch<T>({ settleMs: this.settleMs() });
  }

  enabled(): boolean {
    return this.config.get<boolean>('imagePrefetch.enabled') !== false;
  }

  settleMs(): number {
    const value = this.config.get<number>('imagePrefetch.settleMs');
    return Number.isFinite(value) && (value as number) >= 0
      ? (value as number)
      : DEFAULT_SETTLE_MS;
  }

  downloadTimeoutMs(): number {
    const value = this.config.get<number>('imagePrefetch.downloadTimeoutMs');
    return Number.isFinite(value) && (value as number) > 0
      ? (value as number)
      : DEFAULT_DOWNLOAD_TIMEOUT_MS;
  }

  schedule(
    conversationId: string,
    messageId: string,
    run: () => Promise<T>,
  ): void {
    if (!this.enabled()) return;
    this.prefetch.schedule(conversationId, messageId, run);
  }

  take(
    conversationId: string,
    messageId: string,
    waitMs: number,
  ): Promise<PrefetchTake<T>> {
    return this.prefetch.take(conversationId, messageId, waitMs);
  }

  discard(conversationId: string): void {
    this.prefetch.discard(conversationId);
  }
}
