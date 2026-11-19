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
  | 'successClaimBlocked'
  | 'superseded'
  | 'repeatedQuestion'
  | 'stalledReply'
  | 'silenced'
  | 'silenceChecked'
  | 'silenceOverturned'
  | 'technicalLeak'
  | 'askedDayNotSlots'
  | 'uncheckedDenial';

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
    superseded: 0,
    repeatedQuestion: 0,
    stalledReply: 0,
    silenced: 0,
    silenceChecked: 0,
    silenceOverturned: 0,
    technicalLeak: 0,
    askedDayNotSlots: 0,
    uncheckedDenial: 0,
  };

  increment(counter: ReplyCounter): void {
    this.counters[counter] += 1;
    this.logger.log(`${counter}=${this.counters[counter]}`);
  }

  snapshot(): Record<ReplyCounter, number> {
    return { ...this.counters };
  }
}
