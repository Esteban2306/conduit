import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configFactory, configValidationSchema } from './config';
import { SharedModule } from './shared/shared.module';
import { HealthModule } from './api/health/health.module';
import { TemplateModule } from './core/templates/template.module';
import { ChannelsModule } from './channels/channels.module';
import { QueueModule } from './queue/queue.module';
import { OrchestratorModule } from './core/orchestrator/orchestrator.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configFactory],
      validationSchema: configValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),

    SharedModule,
    HealthModule,
    TemplateModule,
    ChannelsModule,
    QueueModule,
    OrchestratorModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
