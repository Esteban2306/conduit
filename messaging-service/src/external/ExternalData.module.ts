import { Module } from '@nestjs/common';
import { ExternalDataController } from './ExternalData.controller';
import { ExternalDataService } from './ExternalData.service';
import { ExternalDataResolver } from './ExternalDataResolver';
import { PrismaService } from 'src/shared/prisma.service';
import { EventBusService } from 'src/infra/events/event.service';
import { VariableMapper } from './hooks/VariableMapper';
import { VariableStore } from './VariableStore';
import { MappingRepository } from './MappingRepository';
import { SecurityModule } from 'src/shared/security/security.module';
import { ExternalIntegrationController } from './integrations/ExternalIntegration.controller';
import { ExternalIntegrationService } from './integrations/ExternalIntegration.service';
import {
  ExternalIntegrationSecretResolver,
  ExternalIntegrationSignatureGuard,
} from './integrations/ExternalIntegrationSignatureGuard';

@Module({
  imports: [SecurityModule],
  controllers: [ExternalDataController, ExternalIntegrationController],
  providers: [
    PrismaService,
    EventBusService,
    VariableMapper,
    VariableStore,
    MappingRepository,
    ExternalDataService,
    ExternalDataResolver,
    ExternalIntegrationService,
    ExternalIntegrationSecretResolver,
    ExternalIntegrationSignatureGuard,
  ],
  exports: [ExternalDataResolver, ExternalDataService],
})
export class ExternalDataModule {}
