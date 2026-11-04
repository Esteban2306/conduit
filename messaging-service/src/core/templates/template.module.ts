import { Module } from '@nestjs/common';
import { TemplateController } from './template.controller';
import { TemplateEngine } from './TemplateEngine';
import { TemplateService } from './TemplateService';
import { TagController } from './tags/tag.controller';
import { TagService } from './tags/tag.service';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [TemplateController, TagController],
  providers: [TemplateEngine, TemplateService, TagService],
  exports: [TemplateEngine, TemplateService, TagService],
})
export class TemplateModule {}
