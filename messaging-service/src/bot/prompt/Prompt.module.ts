import { Module } from '@nestjs/common';
import { PromptEngine } from './PromptEngine';
import { PromptService } from './Prompt.service';
import { PromptController } from './Prompt.controller';
import { TemplateRepository } from './repositories/TemplateRepository';
import { SettingsRepository } from './repositories/SettingsRepository';
import { VariableResolver } from './VariableResolver';
import { ContextBuilder } from './ContextBuilder';
import { PromptRenderer } from './PromptRenderer';
import { PrismaService } from 'src/shared/prisma.service';
import { KnowledgeAssembler } from '../knowledge/KnowledgeAssembler';
import { ExternalDataModule } from 'src/external/ExternalData.module';

@Module({
  imports: [ExternalDataModule],
  controllers: [PromptController],
  providers: [
    PrismaService,
    TemplateRepository,
    SettingsRepository,
    VariableResolver,
    ContextBuilder,
    PromptRenderer,
    PromptEngine,
    PromptService,
    KnowledgeAssembler,
  ],
  exports: [PromptEngine, KnowledgeAssembler],
})
export class PromptModule {}
