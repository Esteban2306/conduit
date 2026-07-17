import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TemplateService } from './TemplateService';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { PreviewTemplateDto } from './dto/preview-template.dto';
import { FilterTemplateDto } from './dto/filter-template.dto';
import { Public } from 'src/api/middlewares/auth';
import { JwtGuard } from 'src/auth/guards/jwt-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';

@Public()
@UseGuards(JwtGuard)
@ApiTags('Templates')
@Controller('templates')
export class TemplateController {
  constructor(private readonly service: TemplateService) {}

  @Post()
  @ApiOperation({ summary: 'Crea una nueva plantilla HTML con Handlebars' })
  create(@Body() dto: CreateTemplateDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Obtiene todas laas plantillas activas' })
  findAll(@Query() filter: FilterTemplateDto, @CurrentUser() user: JwtPayload) {
    return this.service.findAll(user.tenantId, filter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene una plantilla por su ID' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findOne(id, user.tenantId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualiza una plantilla existenete' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(id, dto, user.tenantId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'ELimina una plantilla por su ID' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.remove(id, user.tenantId);
  }

  @Post(':id/preview')
  @ApiOperation({ summary: 'Previsualiza la plantilla renderizada' })
  preview(
    @Param('id') id: string,
    @Body() dto: PreviewTemplateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.preview(id, dto, user.tenantId);
  }
}
