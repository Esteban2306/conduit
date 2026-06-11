import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configFactory, configValidationSchema } from './config';
import { SharedModule } from './shared/shared.module';
import { HealthModule } from './api/health/health.module';
import { TemplateModule } from './core/templates/template.module';
import { ChannelsModule } from './channels/channels.module';
import { QueueModule } from './queue/queue.module';
import { OrchestratorModule } from './core/orchestrator/orchestrator.module';
import { WebhookModule } from './webhooks/webhook.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { BotModule } from './bot/bot.module';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 10,
      },
      {
        name: 'medium',
        ttl: 60000,
        limit: 200,
      },
    ]),
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configFactory],
      validationSchema: configValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),

    SharedModule,
    WebhookModule,
    HealthModule,
    BotModule,
    TemplateModule,
    ChannelsModule,
    QueueModule,
    OrchestratorModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
