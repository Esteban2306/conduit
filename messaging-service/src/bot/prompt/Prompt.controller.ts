import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { PromptTemplateType } from '@prisma/client';
import { PromptService } from './Prompt.service';

@Controller('bots/:botId/prompts')
export class PromptController {
  constructor(private readonly service: PromptService) {}

  @Get('settings')
  getSettings(@Param('botId') botId: string) {
    return this.service.getSettings(botId);
  }

  @Put('settings')
  updateSettings(@Param('botId') botId: string, @Body() body: any) {
    return this.service.updateSettings(botId, body);
  }

  @Post('preview')
  preview(
    @Param('botId') botId: string,
    @Body('type') type: PromptTemplateType,
  ) {
    return this.service.preview(botId, type);
  }

  @Get()
  listAll(@Param('botId') botId: string) {
    return this.service.listAll(botId);
  }

  @Get(':type')
  getOne(
    @Param('botId') botId: string,
    @Param('type') type: PromptTemplateType,
  ) {
    return this.service.getOne(botId, type);
  }

  @Put(':type')
  update(
    @Param('botId') botId: string,
    @Param('type') type: PromptTemplateType,
    @Body('content') content: string,
  ) {
    return this.service.update(botId, type, content);
  }
}
