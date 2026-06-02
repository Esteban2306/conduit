import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Delete,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { MessageOrchestrator } from './MessageOrchestrator';
import { ListMessageDto } from './dto/list-messages.dto';
import { TemplateService } from '../templates/TemplateService';
import { BulkDispatchDto } from './dto/bulk-dispatch.dto';

@ApiTags('Messages')
@Controller('messages')
export class MessageController {
  constructor(
    private readonly orchestrator: MessageOrchestrator,
    private readonly templateService: TemplateService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Encola un mensaje para envío' })
  dispatch(@Body() body: unknown) {
    return this.orchestrator.dispatch(body);
  }

  @Post('batch')
  @ApiOperation({ summary: 'Encola múltiples mensajes de una vez' })
  dispatchBatch(@Body() body: unknown[]) {
    return this.orchestrator.dispatchBatch(body);
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Envios masivos con templates en comun' })
  async bulkDispatch(@Body() body: BulkDispatchDto) {
    const { templateId, recipients, options } = body;

    const template = await this.templateService.findOne(templateId);

    const payloads = recipients.map((r) => ({
      recipient: {
        channel: template.channel,
        address: r.address,
        name: r.name,
      },
      template: { id: templateId },
      variables: r.variables,
      options,
    }));
    return this.orchestrator.dispatchBatch(payloads);
  }

  @Get()
  @ApiOperation({
    summary:
      'nos da el resultado de todos los elememntos en cola y permite filtrarlo',
    description: `
      Filtros disponibles:
      - queue: immediate | scheduled | all (default: all)
      - status: PENDING | QUEUED | PROCESSING | SENT | FAILED | RETRYING | DEAD | CANCELLED
      - channel: EMAIL | SMTP | WHATSAPP
      - scheduledFrom: ISO 8601
      - scheduledTo: ISO 8601
      - recipient: búsqueda parcial
      - page / limit: paginación

      Los resultados siempre van ordenados por scheduledAt ascendente
      (los más próximos a enviarse aparecen primero).
      `,
  })
  listMessage(@Query() filters: ListMessageDto) {
    return this.orchestrator.listMessage(filters);
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Consulta el estado de un mensaje' })
  getStatus(@Param('id') id: string) {
    return this.orchestrator.getStatus(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancela un mensaje pendiente o en cola' })
  cancel(@Param('id') id: string) {
    return this.orchestrator.cancel(id);
  }
}
