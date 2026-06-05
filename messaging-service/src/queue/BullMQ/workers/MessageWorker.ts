import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { QUEUE_NAMES, MessageJobPayload } from 'src/queue/queues';
import { MessageProcessor } from 'src/queue/processors/MessageProcessor';
import { SignedJobPayload } from 'src/queue/security/JobSigner';

@Injectable()
export class MessageWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageWorker.name);
  private worker: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly processor: MessageProcessor,
  ) {}

  onModuleInit() {
    this.worker = new Worker<SignedJobPayload>(
      QUEUE_NAMES.MESSAGES,
      (job) => this.processor.process(job),
      {
        connection: {
          host: this.config.get<string>('redis.host'),
          port: this.config.get<number>('redis.port'),
        },
        concurrency: 5,
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(
        `Job completado: ${job.id} | messageId: ${job.data.messageId}`,
      );
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Job fallido: ${job?.id} | ${error.message}`);
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
