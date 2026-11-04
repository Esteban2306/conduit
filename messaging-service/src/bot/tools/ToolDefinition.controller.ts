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
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { ToolDefinitionService } from './ToolDefinitionService';
import { CreateToolDefinitionDto } from './dto/create-tool-definition.dto';
import { UpdateToolDefinitionDto } from './dto/update-tool-definition.dto';

@UseGuards(ApiAuthGuard)
@Controller('bots/:botId/tools')
export class ToolDefinitionController {
  constructor(private readonly tools: ToolDefinitionService) {}

  @Get()
  list(@Param('botId') botId: string, @CurrentUser() user: JwtPayload) {
    return this.tools.list(botId, user.tenantId);
  }

  @Post()
  create(
    @Param('botId') botId: string,
    @Body() dto: CreateToolDefinitionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.tools.create(botId, user.tenantId, dto);
  }

  @Patch(':toolId')
  update(
    @Param('botId') botId: string,
    @Param('toolId') toolId: string,
    @Body() dto: UpdateToolDefinitionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.tools.update(botId, toolId, user.tenantId, dto);
  }

  @Delete(':toolId')
  remove(
    @Param('botId') botId: string,
    @Param('toolId') toolId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.tools.remove(botId, toolId, user.tenantId);
  }
}
