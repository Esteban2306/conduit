import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Patch,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { BotConfigService } from './BotConfigService';
import { CreateBotConfigDto } from '../dto/create-bot-config.dto';
import { CreateAiModelDto } from '../dto/create-ai-model.dto';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { JwtGuard } from 'src/auth/guards/jwt-auth.guard';

@UseGuards(JwtGuard)
@ApiTags('Bot Config')
@Controller('bot/config')
export class BotConfigController {
  constructor(private readonly botConfigService: BotConfigService) {}

  @Post()
  @ApiOperation({ summary: 'Crear configuración del bot' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateBotConfigDto) {
    return this.botConfigService.create(user.tenantId, dto);
  }

  @Post(':id/models')
  @ApiOperation({ summary: 'Añadir un modelo de IA al bot' })
  addModel(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateAiModelDto,
  ) {
    return this.botConfigService.addAiModel(id, dto, user.tenantId);
  }

  @Get()
  @ApiOperation({ summary: 'Listar todas las configuraciones' })
  findAll(@CurrentUser() user: JwtPayload) {
    return this.botConfigService.findAll(user.tenantId);
  }

  @Get(':id/models')
  @ApiOperation({
    summary: 'Ver modelos de IA configurados y su estado de uso',
  })
  getModels(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.botConfigService.getAiModels(id, user.tenantId);
  }

  @Patch(':id/models/:modelId/reset')
  @ApiOperation({ summary: 'Resetear contadores de uso de un modelo' })
  resetModel(
    @Param('id') id: string,
    @Param('modelId') modelId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.botConfigService.resetModelCounters(id, modelId, user.tenantId);
  }

  @Delete(':id/models/:modelId')
  @ApiOperation({ summary: 'Eliminar un modelo de IA del bot' })
  removeModel(
    @Param('id') id: string,
    @Param('modelId') modelId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.botConfigService.removeAiModel(id, modelId, user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener una configuración por ID' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.botConfigService.findOne(id, user.tenantId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualizar configuración del bot' })
  update(
    @Param('id') id: string,
    @Body() dto: Partial<CreateBotConfigDto>,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.botConfigService.update(id, dto, user.tenantId);
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: 'Activar o desactivar el bot' })
  toggle(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.botConfigService.toggle(id, user.tenantId);
  }
}
