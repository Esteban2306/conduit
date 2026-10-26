import { Injectable, Logger } from '@nestjs/common';

export type ReplyCounter =
  | 'truncated'
  | 'truncatedRecovered'
  | 'truncatedCut'
  | 'empty'
  | 'emptyRecovered'
  | 'emptyFallback'
  | 'blockedEmpty'
  | 'confirmWithoutAction'
  | 'handoffForced'
  | 'promiseBlocked'
  | 'successClaimBlocked';

@Injectable()
export class ReplyMetricsService {
  private readonly logger = new Logger(ReplyMetricsService.name);
  private readonly counters: Record<ReplyCounter, number> = {
    truncated: 0,
    truncatedRecovered: 0,
    truncatedCut: 0,
    empty: 0,
    emptyRecovered: 0,
    emptyFallback: 0,
    confirmWithoutAction: 0,
    handoffForced: 0,
    promiseBlocked: 0,
    successClaimBlocked: 0,
    blockedEmpty: 0,
  };

  increment(counter: ReplyCounter): void {
    this.counters[counter] += 1;
    this.logger.log(`${counter}=${this.counters[counter]}`);
  }

  snapshot(): Record<ReplyCounter, number> {
    return { ...this.counters };
  }
}
