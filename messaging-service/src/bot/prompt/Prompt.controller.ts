import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { PromptTemplateType } from '@prisma/client';
import { PromptService } from './Prompt.service';
import { JwtGuard } from 'src/auth/guards/jwt-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';

@UseGuards(JwtGuard)
@Controller('bots/:botId/prompts')
export class PromptController {
  constructor(private readonly service: PromptService) {}

  @Get('settings')
  getSettings(@Param('botId') botId: string, @CurrentUser() user: JwtPayload) {
    return this.service.getSettings(botId, user.tenantId);
  }

  @Put('settings')
  updateSettings(
    @Param('botId') botId: string,
    @Body() body: any,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.updateSettings(botId, body, user.tenantId);
  }

  @Post('preview')
  preview(
    @Param('botId') botId: string,
    @Body('type') type: PromptTemplateType,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.preview(botId, type, user.tenantId);
  }

  @Get()
  listAll(@Param('botId') botId: string, @CurrentUser() user: JwtPayload) {
    return this.service.listAll(botId, user.tenantId);
  }

  @Get(':type')
  getOne(
    @Param('botId') botId: string,
    @Param('type') type: PromptTemplateType,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getOne(botId, type, user.tenantId);
  }

  @Put(':type')
  update(
    @Param('botId') botId: string,
    @Param('type') type: PromptTemplateType,
    @Body('content') content: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(botId, type, content, user.tenantId);
  }
}
