import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { PrismaService } from 'src/shared/prisma.service';
import { DLQHandler } from './DLQHandler';

@UseGuards(ApiAuthGuard)
@ApiTags('Dead letters')
@Controller('dead-letters')
export class DeadLetterController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dlq: DLQHandler,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Mensajes que no se pudieron enviar (DLQ)' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Query('requeued') requeued?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
    const where = {
      message: { tenantId: user.tenantId },
      ...(requeued !== undefined && { requeued: requeued === 'true' }),
    };

    const [data, total] = await Promise.all([
      this.prisma.deadLetterMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          message: {
            select: {
              id: true,
              channel: true,
              recipient: true,
              templateId: true,
              renderedBody: true,
              createdAt: true,
              meta: true,
            },
          },
        },
      }),
      this.prisma.deadLetterMessage.count({ where }),
    ]);

    return { data, meta: { total, page: Number(page) || 1, limit: take } };
  }

  @Post(':messageId/requeue')
  @ApiOperation({
    summary:
      'Reintentar un mensaje muerto (vuelve a pasar por la política anti-bloqueo)',
  })
  async requeue(
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const owned = await this.prisma.message.findFirst({
      where: { id: messageId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Mensaje no encontrado');

    await this.dlq.requeue(messageId, user.sub);
    return { messageId, status: 'QUEUED' };
  }
}
