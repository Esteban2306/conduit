import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Delete,
  Query,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  ParseArrayPipe,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { MessageOrchestrator } from './MessageOrchestrator';
import { ListMessageDto } from './dto/list-messages.dto';
import { BulkDispatchDto } from './dto/bulk-dispatch.dto';
import { FileDispatchDto } from './dto/file-dispatch.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { JwtGuard } from 'src/auth/guards/jwt-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';

@UseGuards(JwtGuard)
@ApiTags('Messages')
@Controller('messages')
export class MessageController {
  constructor(private readonly orchestrator: MessageOrchestrator) {}

  @Post()
  @ApiOperation({ summary: 'Encola un mensaje para envío' })
  dispatch(@Body() body: CreateMessageDto, @CurrentUser() user: JwtPayload) {
    return this.orchestrator.dispatch(user.tenantId, body);
  }

  @Post('batch')
  @ApiOperation({ summary: 'Encola múltiples mensajes de una vez' })
  dispatchBatch(
    @Body(new ParseArrayPipe({ items: CreateMessageDto }))
    body: CreateMessageDto[],
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orchestrator.dispatchBatch(user.tenantId, body);
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Envios masivos con templates en comun' })
  bulkDispatch(@Body() body: BulkDispatchDto, @CurrentUser() user: JwtPayload) {
    return this.orchestrator.dispatchBulk(user.tenantId, body);
  }

  @Post('upload')
  @ApiOperation({
    summary: 'Sube un archivo CSV o Excel con destinatarios',
    description: `
      El archivo debe tener como mínimo las columnas: address, channel.
      Columnas adicionales se usan como variables del template.

      Ejemplo de estructura:
      | address           | channel | nombre | pedido |
      |-------------------|---------|--------|--------|
      | example@gmail.com    | EMAIL   | ex   | 1234   |
      | 573001234567      | WHATSAPP| ex    | 5678   |
    `,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        templateId: { type: 'string' },
        extraVariables: { type: 'object' },
        scheduledAt: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['file', 'templateId'],
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  uploadAndDispatch(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({
            fileType: /(csv|xlsx|xls|vnd.openxmlformats|vnd.ms-excel)/,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Body() dto: FileDispatchDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orchestrator.dispatchFromFile(user.tenantId, file, dto);
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
  listMessage(
    @Query() filters: ListMessageDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orchestrator.listMessage(user.tenantId, filters);
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Consulta el estado de un mensaje' })
  getStatus(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orchestrator.getStatus(id, user.tenantId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancela un mensaje pendiente o en cola' })
  cancel(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orchestrator.cancel(id, user.tenantId);
  }
}
