import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TemplateService } from './TemplateService';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { PreviewTemplateDto } from './dto/preview-template.dto';
import { FilterTemplateDto } from './dto/filter-template.dto';

@ApiTags('Templates')
@Controller('templates')
export class TemplateController {
  constructor(private readonly service: TemplateService) {}

  @Post()
  @ApiOperation({ summary: 'Crea una nueva plantilla HTML con Handlebars' })
  create(@Body() dto: CreateTemplateDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Obtiene todas laas plantillas activas' })
  findAll(@Query() filter: FilterTemplateDto) {
    return this.service.findAll(filter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene una plantilla por su ID' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualiza una plantilla existenete' })
  update(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'ELimina una plantilla por su ID' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/preview')
  @ApiOperation({ summary: 'Previsualiza la plantilla renderizada' })
  preview(@Param('id') id: string, @Body() dto: PreviewTemplateDto) {
    return this.service.preview(id, dto);
  }
}
