import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Patch,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { BotConfigService } from './BotConfigService';
import { CreateBotConfigDto } from '../dto/create-bot-config.dto';
import { CreateAiModelDto } from '../dto/create-ai-model.dto';

@ApiTags('Bot Config')
@Controller('bot/config')
export class BotConfigController {
  constructor(private readonly botConfigService: BotConfigService) {}

  @Post()
  @ApiOperation({ summary: 'Crear configuración del bot' })
  create(@Body() dto: CreateBotConfigDto) {
    return this.botConfigService.create(dto);
  }

  @Post(':id/models')
  @ApiOperation({ summary: 'Añadir un modelo de IA al bot' })
  addModel(@Param('id') id: string, @Body() dto: CreateAiModelDto) {
    return this.botConfigService.addAiModel(id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar todas las configuraciones' })
  findAll() {
    return this.botConfigService.findAll();
  }

  @Get(':id/models')
  @ApiOperation({
    summary: 'Ver modelos de IA configurados y su estado de uso',
  })
  getModels(@Param('id') id: string) {
    return this.botConfigService.getAiModels(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener una configuración por ID' })
  findOne(@Param('id') id: string) {
    return this.botConfigService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualizar configuración del bot' })
  update(@Param('id') id: string, @Body() dto: Partial<CreateBotConfigDto>) {
    return this.botConfigService.update(id, dto);
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: 'Activar o desactivar el bot' })
  toggle(@Param('id') id: string) {
    return this.botConfigService.toggle(id);
  }

  @Patch(':id/models/:modelId/reset')
  @ApiOperation({ summary: 'Resetear contadores de uso de un modelo' })
  resetModel(@Param('id') id: string, @Param('modelId') modelId: string) {
    return this.botConfigService.resetModelCounters(modelId);
  }

  @Delete(':id/models/:modelId')
  @ApiOperation({ summary: 'Eliminar un modelo de IA del bot' })
  removeModel(@Param('id') id: string, @Param('modelId') modelId: string) {
    return this.botConfigService.removeAiModel(id, modelId);
  }
}
