import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { IntentMode } from '@prisma/client';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { BotConfigService } from '../config/BotConfigService';
import { IntentHandler } from './IntentHandler';
import { IntentRepository } from './IntentRepository.service';
import type { IntentInput } from './intent-validation';

@UseGuards(ApiAuthGuard)
@Controller('bots/:botId/intents')
export class IntentController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly handler: IntentHandler,
    private readonly botConfigService: BotConfigService,
  ) {}

  @Get()
  list(@Param('botId') botId: string, @CurrentUser() user: JwtPayload) {
    return this.intents.list(botId, user.tenantId);
  }

  @Get(':key')
  get(
    @Param('botId') botId: string,
    @Param('key') key: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.intents.get(botId, user.tenantId, key);
  }

  @Put(':key')
  upsert(
    @Param('botId') botId: string,
    @Param('key') key: string,
    @Body() body: IntentInput,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.intents.upsert(botId, user.tenantId, key, body);
  }

  @Patch(':key/mode')
  setMode(
    @Param('botId') botId: string,
    @Param('key') key: string,
    @Body() body: { mode: IntentMode },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.intents.setMode(botId, user.tenantId, key, body.mode);
  }

  @Delete(':key')
  remove(
    @Param('botId') botId: string,
    @Param('key') key: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.intents.remove(botId, user.tenantId, key);
  }

  /** Clasifica una frase con las reglas del bot, sin responder ni llamar herramientas. */
  @Post('test')
  async test(
    @Param('botId') botId: string,
    @Body() body: { text: string; openFlow?: boolean },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.botConfigService.findOne(botId, user.tenantId);
    const result = await this.handler.dryRun(
      botId,
      String(body.text ?? ''),
      Boolean(body.openFlow),
    );
    return result.decided
      ? {
          decided: true,
          intent: result.intent.key,
          handler: result.intent.handler,
          mode: result.intent.mode,
          confidence: result.confidence,
          entity: result.entity ?? null,
        }
      : {
          decided: false,
          reason: result.reason,
          candidate: result.candidate ?? null,
        };
  }
}
