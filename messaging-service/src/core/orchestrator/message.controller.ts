import { Body, Controller, Get, Param, Post, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { MessageOrchestrator } from './MessageOrchestrator';

@ApiTags('Messages')
@Controller('messages')
export class MessageController {
  constructor(private readonly orchestrator: MessageOrchestrator) {}

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
