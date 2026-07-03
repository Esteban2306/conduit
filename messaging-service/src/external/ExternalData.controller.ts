import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ExternalDataService } from './ExternalData.service';
import { SourceVariable } from '@prisma/client';

@Controller('api/external-data')
export class ExternalDataController {
  constructor(private readonly service: ExternalDataService) {}

  @Post(':botId/webhook/:eventType')
  receiveWebhook(
    @Param('botId') botId: string,
    @Param('eventType') eventType: string,
    @Body() payload: Record<string, any>,
  ) {
    return this.service.receiveWebhook(botId, eventType, payload);
  }

  @Post(':botId/variables')
  injectDirect(
    @Param('botId') botId: string,
    @Body()
    body: {
      variables: Record<string, string>;
      ttlSeconds?: number;
      source: SourceVariable;
    },
  ) {
    return this.service.injectDirect(
      botId,
      body.variables,
      body.source,
      body.ttlSeconds,
    );
  }

  @Get(':botId/variables')
  getVariables(
    @Param('botId') botId: string,
    @Query('namespace') namespace?: string,
  ) {
    return this.service.getVariables(botId, namespace);
  }

  @Delete(':botId/variables')
  deleteVariables(@Param('botId') botId: string, @Query('keys') keys?: string) {
    return this.service.deleteVariables(botId, keys?.split(','));
  }

  @Get(':botId/mappings')
  getMappings(@Param('botId') botId: string) {
    return this.service.getAllMappings(botId);
  }

  @Post(':botId/mappings/:eventType')
  upsertMapping(
    @Param('botId') botId: string,
    @Param('eventType') eventType: string,
    @Body() body: { rules: Record<string, string>; description?: string },
  ) {
    return this.service.upsertMapping(
      botId,
      eventType,
      body.rules,
      body.description,
    );
  }

  @Delete(':botId/mappings/:eventType')
  deleteMapping(
    @Param('botId') botId: string,
    @Param('eventType') eventType: string,
  ) {
    return this.service.deleteMapping(botId, eventType);
  }

  @Get(':botId/events')
  getEvents(@Param('botId') botId: string, @Query('limit') limit?: string) {
    return this.service.getEventHistory(botId, limit ? parseInt(limit) : 50);
  }
}
