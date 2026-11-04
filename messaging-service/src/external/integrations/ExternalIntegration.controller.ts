import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { ExternalIntegrationService } from './ExternalIntegration.service';
import { CreateExternalIntegrationDto } from './dto/create-external-integration.dto';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';

@UseGuards(ApiAuthGuard)
@Controller('bots/:botId/integrations')
export class ExternalIntegrationController {
  constructor(private readonly service: ExternalIntegrationService) {}

  @Post()
  create(
    @Param('botId') botId: string,
    @Body() dto: CreateExternalIntegrationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.create(botId, user.tenantId, dto);
  }

  @Get()
  findAll(@Param('botId') botId: string, @CurrentUser() user: JwtPayload) {
    return this.service.findAll(botId, user.tenantId);
  }

  @Delete(':integrationId')
  revoke(
    @Param('botId') botId: string,
    @Param('integrationId') integrationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.revoke(botId, integrationId, user.tenantId);
  }
}
