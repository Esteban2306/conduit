import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ExternalDataService } from './ExternalData.service';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { ExternalIntegrationSignatureGuard } from './integrations/ExternalIntegrationSignatureGuard';
import { InjectDataDto } from './dto/InjectDataDto';
import { UpsertMappingDto } from './dto/upsert-mapping.dto';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';

@Controller('api/external-data')
export class ExternalDataController {
  constructor(private readonly service: ExternalDataService) {}

  @UseGuards(ExternalIntegrationSignatureGuard)
  @Post(':botId/webhook/:eventType')
  receiveWebhook(
    @Param('botId') botId: string,
    @Param('eventType') eventType: string,
    @Body() payload: Record<string, any>,
    @Headers('x-conduit-event-id') externalEventId?: string,
  ) {
    return this.service.receiveWebhook(
      botId,
      eventType,
      payload,
      externalEventId,
    );
  }

  @UseGuards(ApiAuthGuard)
  @Post(':botId/variables')
  injectDirect(
    @Param('botId') botId: string,
    @Body() dto: InjectDataDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.injectDirect(
      botId,
      dto.variables,
      dto.source,
      user.tenantId,
      dto.ttlSeconds,
    );
  }

  @UseGuards(ApiAuthGuard)
  @Get(':botId/variables')
  getVariables(
    @Param('botId') botId: string,
    @CurrentUser() user: JwtPayload,
    @Query('namespace') namespace?: string,
  ) {
    return this.service.getVariables(botId, user.tenantId, namespace);
  }

  @UseGuards(ApiAuthGuard)
  @Delete(':botId/variables')
  deleteVariables(
    @Param('botId') botId: string,
    @CurrentUser() user: JwtPayload,
    @Query('keys') keys?: string,
  ) {
    return this.service.deleteVariables(botId, user.tenantId, keys?.split(','));
  }

  @UseGuards(ApiAuthGuard)
  @Get(':botId/mappings')
  getMappings(@Param('botId') botId: string, @CurrentUser() user: JwtPayload) {
    return this.service.getAllMappings(botId, user.tenantId);
  }

  @UseGuards(ApiAuthGuard)
  @Post(':botId/mappings/:eventType')
  upsertMapping(
    @Param('botId') botId: string,
    @Param('eventType') eventType: string,
    @Body() dto: UpsertMappingDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.upsertMapping(
      botId,
      eventType,
      dto.rules,
      user.tenantId,
      dto.description,
      dto.action,
    );
  }

  @UseGuards(ApiAuthGuard)
  @Delete(':botId/mappings/:eventType')
  deleteMapping(
    @Param('botId') botId: string,
    @Param('eventType') eventType: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.deleteMapping(botId, eventType, user.tenantId);
  }

  @UseGuards(ApiAuthGuard)
  @Get(':botId/events')
  getEvents(
    @Param('botId') botId: string,
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit?: string,
  ) {
    return this.service.getEventHistory(
      botId,
      user.tenantId,
      limit ? parseInt(limit) : 50,
    );
  }
}
