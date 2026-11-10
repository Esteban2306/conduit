import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { WhatsAppConnectionService } from 'src/channels/whatsapp/WhatsAppConnection.service';

@UseGuards(ApiAuthGuard)
@ApiTags('Resolve')
@Controller('resolve')
export class ResolveController {
  constructor(private readonly connections: WhatsAppConnectionService) {}

  @Get()
  @ApiOperation({
    summary: 'Resuelve una línea por su clave estable',
    description:
      'Devuelve los ids internos de la línea y del bot asignado. botId es null si la línea no tiene bot. El tenant sale siempre del token.',
  })
  async resolve(
    @Query('line') line: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!line) {
      throw new BadRequestException('Falta el parámetro "line".');
    }
    const connection = await this.connections.findByKey(line, user.tenantId);
    return {
      tenantId: connection.tenantId,
      lineId: connection.id,
      botId: connection.botConfigId,
    };
  }
}
