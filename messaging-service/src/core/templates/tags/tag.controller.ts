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

@Public()
@UseGuards(JwtGuard)
@ApiTags('Tags')
@Controller('tags')
export class TagController {
  constructor(private readonly service: TagService) {}

  @Post()
  @ApiOperation({ summary: 'Crea un nuevo tag' })
  create(@Body() dto: CreateTagDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista todos los tags del tenant' })
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene un tag por su ID' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualiza un tag existente' })
  update(@Param('id') id: string, @Body() dto: UpdateTagDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Elimina un tag (desasigna de todos sus templates)',
  })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post('templates/:templateId/assign')
  @ApiOperation({ summary: 'Asigna tags a un template' })
  assignToTemplate(
    @Param('templateId') templateId: string,

    @Body() dto: AssignTagDto,
  ) {
    return this.service.assignToTemplate(templateId, dto.tagIds);
  }

  @Delete('templates/:templateId/unassign')
  @ApiOperation({ summary: 'Desasigna tags de un template' })
  unassignFromTemplate(
    @Param('templateId') templateId: string,

    @Body() dto: AssignTagDto,
  ) {
    return this.service.unassignFromTemplate(templateId, dto.tagIds);
  }
}
