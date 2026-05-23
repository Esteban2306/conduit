import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configFactory, configValidationSchema } from './config'
import { SharedModule } from './shared/shared.module';
import { HealthModule } from './api/health/health.module';
import { TemplateModule } from './core/templates/template.module';
import { ChannelsModule } from './channels/channels.module';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configFactory],
      validationSchema: configValidationSchema,
      validationOptions: {
        abortEarly: true
      }
    }),
    
    SharedModule,
    HealthModule,
    TemplateModule,
    ChannelsModule
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
