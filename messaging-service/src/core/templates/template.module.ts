import { Module } from '@nestjs/common';
import { TemplateController } from './template.controller';
import { TemplateEngine } from './TemplateEngine';
import { TemplateService } from './TemplateService';
import { TagController } from './tags/tag.controller';
import { TagService } from './tags/tag.service';

@Module({
  controllers: [TemplateController, TagController],
  providers: [TemplateEngine, TemplateService, TagService],
  exports: [TemplateEngine, TemplateService, TagService],
})
export class TemplateModule {}
