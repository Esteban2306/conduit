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

@Module({
  imports: [
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
