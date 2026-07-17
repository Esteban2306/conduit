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
import { BaileysSessionManager } from './baileys/BaileysSessionManager';
import { CreateWhatsAppConnectionDto } from './dto/create-whatsapp-connection.dto';
import { WhatsAppConnectionService } from './WhatsAppConnection.service';
import { JwtGuard } from 'src/auth/guards/jwt-auth.guard';

@UseGuards(JwtGuard)
@ApiTags('WhatsApp Connections')
@Controller('whatsapp/connections')
export class ConnectionController {
  constructor(
    private readonly connections: WhatsAppConnectionService,
    private readonly sessionManager: BaileysSessionManager,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Crear e iniciar una conexión de WhatsApp' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateWhatsAppConnectionDto,
  ) {
    const connection = await this.connections.create(user.tenantId, dto);
    await this.connections.connect(connection.id, user.tenantId);
    await this.sessionManager.start(connection.id);
    return this.connections.findOne(connection.id, user.tenantId);
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

  @Post(':id/connect')
  @ApiOperation({ summary: 'Iniciar una conexión de WhatsApp' })
  async connect(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    await this.connections.connect(id, user.tenantId);
    await this.sessionManager.start(id);
    return this.connections.findOne(id, user.tenantId);
  }

  @Post(':id/disconnect')
  @ApiOperation({
    summary: 'Detener una conexión de WhatsApp sin borrar su sesión',
  })
  async disconnect(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    await this.connections.findOne(id, user.tenantId);
    await this.sessionManager.stop(id);
    return this.connections.disconnect(id, user.tenantId);
  }

  @Post(':id/reconnect')
  @ApiOperation({ summary: 'Reiniciar una conexión de WhatsApp' })
  async reconnect(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    await this.connections.restart(id, user.tenantId);
    await this.sessionManager.reconnect(id);
    return this.connections.findOne(id, user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener una conexión de WhatsApp' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.connections.findOne(id, user.tenantId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar una conexión y sus credenciales' })
  async delete(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    await this.connections.findOne(id, user.tenantId);
    await this.sessionManager.stop(id);
    await this.connections.delete(id, user.tenantId);
    return { id, deleted: true };
  }
}
