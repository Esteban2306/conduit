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
import { CurrentUser } from './decorators/current-user.decorator';
import type { JwtPayload } from './types/jwt.types';
import { JwtGuard } from './guards/jwt-auth.guard';
import { ApiKeyService } from './api/ApiKeyService';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@UseGuards(JwtGuard)
@ApiTags('API Keys')
@Controller('auth/api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post()
  @ApiOperation({
    summary: 'Crea una API key para integraciones externas del tenant',
    description:
      'El valor de la key se devuelve UNA sola vez en la respuesta. Guárdalo de inmediato en el backend consumidor — Conduit no lo vuelve a mostrar después.',
  })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateApiKeyDto) {
    return this.apiKeyService.create(user.tenantId, dto.name);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista las API keys del tenant (sin exponer el valor real)',
  })
  findAll(@CurrentUser() user: JwtPayload) {
    return this.apiKeyService.findAll(user.tenantId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoca una API key' })
  revoke(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.apiKeyService.revoke(id, user.tenantId);
  }
}
