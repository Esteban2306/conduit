import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConversationStatus } from '@prisma/client';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { PrismaService } from 'src/shared/prisma.service';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { BotConfigService } from '../config/BotConfigService';
import { ConversationService } from '../conversation/ConversationService';
import { BotRouter } from '../router/BotRouter';
import { normalizeWhatsAppAddress } from 'src/channels/whatsapp/utils/whatsapp-address.util';
import {
  CreateEscalationContactDto,
  HumanReplyDto,
  PauseConversationDto,
} from './dto/conversation-admin.dto';

/**
 * Operación humana sobre las conversaciones del bot: ver, pausar, tomar el
 * control y responder como persona. Todo acotado al tenant del usuario.
 */
@UseGuards(ApiAuthGuard)
@ApiTags('Bot conversations')
@Controller('bots/:botId')
export class ConversationAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: BotConfigService,
    private readonly conversations: ConversationService,
    private readonly router: BotRouter,
    private readonly eventBus: EventBusService,
  ) {}

  @Get('conversations')
  @ApiOperation({ summary: 'Conversaciones del bot (más recientes primero)' })
  async list(
    @Param('botId', ParseUUIDPipe) botId: string,
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: ConversationStatus,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    await this.bots.findOne(botId, user.tenantId);
    if (status && !Object.values(ConversationStatus).includes(status)) {
      throw new BadRequestException('status inválido');
    }
    return this.conversations.listForAdmin(botId, {
      status,
      search: search?.replace(/[^\d@lid]/g, ''),
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('conversations/:conversationId/messages')
  @ApiOperation({
    summary: 'Historial de una conversación (paginado hacia atrás)',
  })
  async messages(
    @Param('botId', ParseUUIDPipe) botId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @CurrentUser() user: JwtPayload,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    await this.ownedConversation(botId, conversationId, user.tenantId);
    const beforeDate = before ? new Date(before) : undefined;
    if (beforeDate && Number.isNaN(beforeDate.getTime())) {
      throw new BadRequestException('before debe ser una fecha ISO 8601');
    }
    return this.conversations.getMessagesPage(conversationId, {
      before: beforeDate,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('conversations/:conversationId/pause')
  @ApiOperation({
    summary: 'Pausar el bot en esta conversación (una persona atiende)',
  })
  async pause(
    @Param('botId', ParseUUIDPipe) botId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: PauseConversationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.ownedConversation(botId, conversationId, user.tenantId);
    const until = await this.conversations.pauseBot(
      conversationId,
      dto.minutes,
      dto.reason ?? 'Pausado desde el panel',
    );
    return { conversationId, botPausedUntil: until };
  }

  @Post('conversations/:conversationId/resume')
  @ApiOperation({
    summary:
      'Reanudar el bot; responde lo que el cliente escribió durante la pausa',
  })
  async resume(
    @Param('botId', ParseUUIDPipe) botId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.ownedConversation(botId, conversationId, user.tenantId);
    await this.router.resumeConversation(conversationId, user.tenantId);
    return { conversationId, botPaused: false };
  }

  @Post('conversations/:conversationId/messages')
  @ApiOperation({
    summary:
      'Responder como persona desde el panel (el bot queda en pausa por takeover humano)',
  })
  async reply(
    @Param('botId', ParseUUIDPipe) botId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: HumanReplyDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const conversation = await this.ownedConversation(
      botId,
      conversationId,
      user.tenantId,
    );
    if (!conversation.lastConnectionId) {
      throw new BadRequestException(
        'La conversación no tiene una conexión de WhatsApp asociada.',
      );
    }

    // Prioridad de conversación: el cliente escribió, no aplica la política
    // de campañas, pero sí el rate limiter y la separación natural.
    const [result] = (await this.eventBus.publishAsync(
      EVENT_TYPES.CHANNEL_SEND_REQUESTED,
      {
        phoneNumber: conversation.phoneNumber,
        content: dto.text,
        conversationId,
        connectionId: conversation.lastConnectionId,
        sentBy: 'human',
      },
    )) as unknown as Array<{ success: boolean; error?: string } | undefined>;

    if (!result?.success) {
      throw new BadRequestException(
        `No fue posible enviar el mensaje: ${result?.error ?? 'error desconocido'}`,
      );
    }
    return { conversationId, sent: true };
  }

  @Post('conversations/:conversationId/close')
  @ApiOperation({
    summary:
      'Cerrar la conversación (se reabre si el cliente vuelve a escribir)',
  })
  async close(
    @Param('botId', ParseUUIDPipe) botId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.ownedConversation(botId, conversationId, user.tenantId);
    await this.conversations.close(
      conversationId,
      ConversationStatus.COMPLETED,
    );
    return { conversationId, status: ConversationStatus.COMPLETED };
  }

  @Get('escalation-contacts')
  @ApiOperation({ summary: 'A quién avisa el bot cuando falla o pide ayuda' })
  async listEscalation(
    @Param('botId', ParseUUIDPipe) botId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.bots.findOne(botId, user.tenantId);
    return this.prisma.botEscalationContact.findMany({
      where: { botConfigId: botId },
      orderBy: { label: 'asc' },
    });
  }

  @Post('escalation-contacts')
  async createEscalation(
    @Param('botId', ParseUUIDPipe) botId: string,
    @Body() dto: CreateEscalationContactDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.bots.findOne(botId, user.tenantId);
    const phoneNumber = normalizeWhatsAppAddress(dto.phoneNumber);
    if (!phoneNumber) throw new BadRequestException('phoneNumber inválido');

    if (dto.connectionId) {
      const connection = await this.prisma.whatsAppConnection.findFirst({
        where: { id: dto.connectionId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!connection) throw new NotFoundException('Conexión no encontrada');
    }

    return this.prisma.botEscalationContact.create({
      data: {
        botConfigId: botId,
        label: dto.label,
        phoneNumber,
        connectionId: dto.connectionId ?? null,
        notifyOn: dto.notifyOn ?? ['TECHNICAL_ERROR'],
      },
    });
  }

  @Delete('escalation-contacts/:contactId')
  async removeEscalation(
    @Param('botId', ParseUUIDPipe) botId: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.bots.findOne(botId, user.tenantId);
    const { count } = await this.prisma.botEscalationContact.deleteMany({
      where: { id: contactId, botConfigId: botId },
    });
    if (!count) throw new NotFoundException('Contacto no encontrado');
    return { id: contactId, deleted: true };
  }

  private async ownedConversation(
    botId: string,
    conversationId: string,
    tenantId: string,
  ) {
    await this.bots.findOne(botId, tenantId);
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, botConfigId: botId, tenantId },
    });
    if (!conversation)
      throw new NotFoundException('Conversación no encontrada');
    return conversation;
  }
}
