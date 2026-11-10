import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { TenantAdminGuard } from 'src/auth/guards/tenant-admin.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { SpecialistBindingService } from './SpecialistBindingService';

@UseGuards(ApiAuthGuard)
@ApiTags('Specialists')
@Controller('bots/:botId/specialists')
export class SpecialistBindingController {
  constructor(private readonly bindings: SpecialistBindingService) {}

  @Get()
  @ApiOperation({ summary: 'Vínculos del bot con especialistas' })
  list(@CurrentUser() user: JwtPayload, @Param('botId') botId: string) {
    return this.bindings.list(user.tenantId, botId);
  }

  @UseGuards(TenantAdminGuard)
  @Put(':capability')
  @ApiOperation({
    summary:
      'Crear o cambiar el vínculo de una capacidad (modo OFF, SHADOW o ACTIVE) con topes de seguridad',
  })
  upsert(
    @CurrentUser() user: JwtPayload,
    @Param('botId') botId: string,
    @Param('capability') capability: string,
    @Body() body: unknown,
  ) {
    return this.bindings.upsert(user.tenantId, botId, capability, body);
  }

  @UseGuards(TenantAdminGuard)
  @Delete(':capability')
  @ApiOperation({ summary: 'Eliminar un vínculo apagado (modo OFF)' })
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('botId') botId: string,
    @Param('capability') capability: string,
  ) {
    return this.bindings.remove(user.tenantId, botId, capability);
  }
}
