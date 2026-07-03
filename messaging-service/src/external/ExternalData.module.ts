import { Module } from '@nestjs/common';
import { ExternalDataController } from './ExternalData.controller';
import { ExternalDataService } from './ExternalData.service';
import { ExternalDataResolver } from './ExternalDataResolver';
import { PrismaService } from 'src/shared/prisma.service';
import { EventBusService } from 'src/infra/events/event.service';
import { VariableMapper } from './hooks/VariableMapper';
import { VariableStore } from './VariableStore';
import { MappingRepository } from './MappingRepository';

@Module({
  controllers: [ExternalDataController],
  providers: [
    PrismaService,
    EventBusService,
    VariableMapper,
    VariableStore,
    MappingRepository,
    ExternalDataService,
    ExternalDataResolver,
  ],
  exports: [ExternalDataResolver, ExternalDataService],
})
export class ExternalDataModule {}
