import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { TenantAdminGuard } from 'src/auth/guards/tenant-admin.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { SpecialistModelService } from './SpecialistModelService';

@UseGuards(ApiAuthGuard)
@ApiTags('Specialists')
@Controller('specialists/:id/models')
export class SpecialistModelController {
  constructor(private readonly models: SpecialistModelService) {}

  @Get()
  @ApiOperation({
    summary:
      'Modelos del especialista y su estado de uso (la clave nunca se devuelve)',
  })
  list(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.models.list(user.tenantId, id);
  }

  @UseGuards(TenantAdminGuard)
  @Post()
  @ApiOperation({ summary: 'Añadir un modelo propio al especialista' })
  create(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.models.create(user.tenantId, id, body);
  }

  @UseGuards(TenantAdminGuard)
  @Patch(':modelId')
  @ApiOperation({
    summary:
      'Modificar un modelo o rotar su clave (rotarla limpia el estado de fallos)',
  })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('modelId') modelId: string,
    @Body() body: unknown,
  ) {
    return this.models.update(user.tenantId, id, modelId, body);
  }

  @UseGuards(TenantAdminGuard)
  @Post(':modelId/reactivate')
  @ApiOperation({
    summary:
      'Reactivar un modelo: limpia contadores y fallos y confirma con una llamada de prueba',
  })
  reactivate(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('modelId') modelId: string,
  ) {
    return this.models.reactivate(user.tenantId, id, modelId);
  }

  @UseGuards(TenantAdminGuard)
  @Delete(':modelId')
  @ApiOperation({ summary: 'Eliminar un modelo del especialista' })
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('modelId') modelId: string,
  ) {
    return this.models.remove(user.tenantId, id, modelId);
  }
}
