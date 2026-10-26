import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import {
  IntentConfigService,
  type UpsertQuickReplyInput,
} from './IntentConfig.service';

@UseGuards(ApiAuthGuard)
@Controller('bots/:botId/quick-replies')
export class QuickReplyController {
  constructor(private readonly intents: IntentConfigService) {}

  @Get()
  list(@Param('botId') botId: string, @CurrentUser() user: JwtPayload) {
    return this.intents.list(botId, user.tenantId);
  }

  @Put(':intent')
  upsert(
    @Param('botId') botId: string,
    @Param('intent') intent: string,
    @Body() body: UpsertQuickReplyInput,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.intents.upsert(botId, user.tenantId, intent, body);
  }
}
