import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { AdminGuard } from 'src/auth/guards/admin.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { SpecialistAdminService } from './SpecialistAdminService';

@UseGuards(ApiAuthGuard)
@ApiTags('Specialists')
@Controller('specialists')
export class SpecialistController {
  constructor(private readonly specialists: SpecialistAdminService) {}

  @Get()
  @ApiOperation({ summary: 'Listar los especialistas del tenant' })
  list(@CurrentUser() user: JwtPayload, @Query() query: unknown) {
    return this.specialists.list(user.tenantId, query);
  }

  @Get('by-key/:key')
  @ApiOperation({ summary: 'Obtener un especialista por su clave estable' })
  getByKey(@CurrentUser() user: JwtPayload, @Param('key') key: string) {
    return this.specialists.getByKey(user.tenantId, key);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver un especialista' })
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.specialists.get(user.tenantId, id);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Historial de versiones de un especialista' })
  listVersions(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.specialists.listVersions(user.tenantId, id);
  }

  @Get(':id/versions/:version')
  @ApiOperation({ summary: 'Ver el contenido de una versión' })
  getVersion(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.specialists.getVersion(user.tenantId, id, version);
  }

  @UseGuards(AdminGuard)
  @Post()
  @ApiOperation({ summary: 'Crear un especialista (nace inactivo)' })
  create(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    return this.specialists.create(user.tenantId, user.sub, body);
  }

  @UseGuards(AdminGuard)
  @Patch(':id')
  @ApiOperation({
    summary:
      'Modificar nombre, prompt, reglas, contexto o estado. Un cambio de contenido crea una versión nueva',
  })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.specialists.update(user.tenantId, user.sub, id, body);
  }

  @UseGuards(AdminGuard)
  @Post(':id/versions/:version/restore')
  @ApiOperation({
    summary:
      'Restaurar una versión anterior como una versión nueva (el historial no se reescribe)',
  })
  restore(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() body: unknown,
  ) {
    return this.specialists.restore(user.tenantId, user.sub, id, version, body);
  }

  @UseGuards(AdminGuard)
  @Post(':id/archive')
  @ApiOperation({ summary: 'Archivar un especialista sin vínculos en uso' })
  archive(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.specialists.archive(user.tenantId, id);
  }

  @UseGuards(AdminGuard)
  @Post(':id/unarchive')
  @ApiOperation({ summary: 'Desarchivar un especialista' })
  unarchive(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.specialists.unarchive(user.tenantId, id);
  }
}
