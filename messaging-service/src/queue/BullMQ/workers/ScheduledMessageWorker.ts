import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { QUEUE_NAMES, MessageJobPayload } from 'src/queue/queues';
import { MessageProcessor } from 'src/queue/processors/MessageProcessor';

@Injectable()
export class ScheduledMessageWorker implements OnModuleInit, OnModuleDestroy {
  private worker: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly processor: MessageProcessor,
  ) {}

  onModuleInit() {
    this.worker = new Worker<MessageJobPayload>(
      QUEUE_NAMES.MESSAGES_SCHEDULED,
      (job) => this.processor.process(job),
      {
        connection: {
          host: this.config.get<string>('redis.host'),
          port: this.config.get<number>('redis.port'),
        },
        concurrency: 2,
      },
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
