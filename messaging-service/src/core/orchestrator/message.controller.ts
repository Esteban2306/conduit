import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Delete,
  Query,
  UseInterceptors,
  UploadedFiles,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { MessageOrchestrator } from './MessageOrchestrator';
import { ListMessageDto } from './dto/list-messages.dto';
import { TemplateService } from '../templates/TemplateService';
import { BulkDispatchDto } from './dto/bulk-dispatch.dto';
import { FileParserService } from '../adapters/FileParserService';
import { FileDispatchDto } from './dto/file-dispatch.dto';
import { Public } from 'src/api/middlewares/auth';
import { JwtGuard } from 'src/auth/guards/jwt-auth.guard';

@Public()
@UseGuards(JwtGuard)
@ApiTags('Messages')
@Controller('messages')
export class MessageController {
  constructor(
    private readonly orchestrator: MessageOrchestrator,
    private readonly templateService: TemplateService,
    private readonly fileParser: FileParserService,
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
  async uploadAndDispatch(
    @UploadedFiles(
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
  ) {
    const parsed = this.fileParser.parse(
      file.buffer,
      file.mimetype,
      file.originalname,
    );

    if (parsed.errors.length > 0) {
      return {
        warning: `${parsed.errors.length} filas tuvieron errores de parseo y fueron ignoradas`,
        parseErrors: parsed.errors,
      };
    }

    const payloads = this.fileParser.rowsToPayloads(
      parsed.rows,
      dto.templateId,
      dto.extraVariables ?? {},
      dto.scheduledAt ?? '',
      dto.priority,
    );

    const result = await this.orchestrator.dispatchBatch(payloads);

    return {
      ...result,
      fileInfo: {
        fileName: file.originalname,
        totalRows: parsed.totalRows,
        headers: parsed.headers,
      },
    };
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
