import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { CreateWhatsAppConnectionDto } from './dto/create-whatsapp-connection.dto';
import { AssignBotConfigDto } from './dto/assign-bot-config.dto';
import { WhatsAppConnectionService } from './WhatsAppConnection.service';
import { WhatsAppConnectionOrchestrator } from './WhatsAppConnectionOrchestrator';
import { UpdateWarmupLevelDto } from './dto/update-warmup-level.dto';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';

@UseGuards(ApiAuthGuard)
@ApiTags('WhatsApp Connections')
@Controller('whatsapp/connections')
export class ConnectionController {
  constructor(
    private readonly connections: WhatsAppConnectionService,
    private readonly orchestrator: WhatsAppConnectionOrchestrator,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Crear e iniciar una conexión de WhatsApp',
    description:
      'botConfigId es opcional. Sin él, la conexión queda operativa para envíos por API/campaña, sin bot respondiendo mensajes entrantes hasta que se le asigne uno.',
  })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateWhatsAppConnectionDto,
  ) {
    return this.orchestrator.createAndStart(user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar las conexiones de WhatsApp del tenant' })
  findAll(@CurrentUser() user: JwtPayload) {
    return this.connections.findAll(user.tenantId);
  }

  @Get(':id/qr')
  @ApiOperation({ summary: 'Consultar el QR actual de una conexión' })
  async getQr(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    const connection = await this.connections.findOne(id, user.tenantId);
    return {
      id: connection.id,
      status: connection.status,
      lastQr: connection.lastQr,
    };
  }

  @Get(':id/health')
  @ApiOperation({
    summary:
      'Estado operativo de la conexión: nivel de riesgo anti-ban, warmup y tamaño de cola',
  })
  getHealth(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orchestrator.getHealth(id, user.tenantId);
  }

  @Post(':id/connect')
  @ApiOperation({ summary: 'Iniciar una conexión de WhatsApp' })
  connect(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orchestrator.connect(id, user.tenantId);
  }

  @Post(':id/disconnect')
  @ApiOperation({
    summary: 'Detener una conexión de WhatsApp sin borrar su sesión',
  })
  disconnect(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orchestrator.disconnect(id, user.tenantId);
  }

  @Post(':id/reconnect')
  @ApiOperation({ summary: 'Reiniciar una conexión de WhatsApp' })
  reconnect(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orchestrator.reconnect(id, user.tenantId);
  }

  @Post(':id/warmup-level')
  @ApiOperation({
    summary: 'Configura el nivel de calentamiento anti-ban de la conexión',
  })
  updateWarmupLevel(
    @Param('id') id: string,
    @Body() dto: UpdateWarmupLevelDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orchestrator.updateWarmupLevel(
      id,
      user.tenantId,
      dto.warmupLevel,
    );
  }

  @Post(':id/assign-bot')
  @ApiOperation({
    summary: 'Asigna (o reasigna) un BotConfig a una conexión existente',
  })
  assignBotConfig(
    @Param('id') id: string,
    @Body() dto: AssignBotConfigDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orchestrator.assignBotConfig(
      id,
      user.tenantId,
      dto.botConfigId,
    );
  }

  @Delete(':id/assign-bot')
  @ApiOperation({
    summary: 'Quita el bot asignado — la conexión sigue activa para envíos',
  })
  unassignBotConfig(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orchestrator.unassignBotConfig(id, user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener una conexión de WhatsApp' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.connections.findOne(id, user.tenantId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar una conexión y sus credenciales' })
  delete(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orchestrator.remove(id, user.tenantId);
  }
}
