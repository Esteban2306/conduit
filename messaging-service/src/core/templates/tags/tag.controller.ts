import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';

import { ApiTags, ApiOperation } from '@nestjs/swagger';

import { TagService } from './tag.service';

import { CreateTagDto } from './dto/create-tag.dto';

import { UpdateTagDto } from './dto/update-tag.dto';

import { AssignTagDto } from './dto/assign-tag.dto';
import { JwtGuard } from 'src/auth/guards/jwt-auth.guard';
import { Public } from 'src/api/middlewares/auth';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';

@UseGuards(JwtGuard)
@ApiTags('Tags')
@Controller('tags')
export class TagController {
  constructor(private readonly service: TagService) {}

  @Post()
  @ApiOperation({ summary: 'Crea un nuevo tag' })
  create(@Body() dto: CreateTagDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user.tenantId);
  }

  @Get()
  @ApiOperation({ summary: 'Lista todos los tags del tenant' })
  findAll(@CurrentUser() user: JwtPayload) {
    return this.service.findAll(user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene un tag por su ID' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findOne(id, user.tenantId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualiza un tag existente' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTagDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(id, dto, user.tenantId);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Elimina un tag (desasigna de todos sus templates)',
  })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.remove(id, user.tenantId);
  }

  @Post('templates/:templateId/assign')
  @ApiOperation({ summary: 'Asigna tags a un template' })
  assignToTemplate(
    @Param('templateId') templateId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AssignTagDto,
  ) {
    return this.service.assignToTemplate(templateId, dto.tagIds, user.tenantId);
  }

  @Delete('templates/:templateId/unassign')
  @ApiOperation({ summary: 'Desasigna tags de un template' })
  unassignFromTemplate(
    @Param('templateId') templateId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AssignTagDto,
  ) {
    return this.service.unassignFromTemplate(templateId, dto.tagIds);
  }
}
