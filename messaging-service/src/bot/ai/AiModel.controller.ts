import { Controller, Optional, Param, Patch, UseGuards } from '@nestjs/common';
import { AiModelRole } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { maskSecrets } from 'src/shared/security/mask-secrets';
import { PrismaService } from 'src/shared/prisma.service';
import { BotConfigService } from '../config/BotConfigService';
import { AI_MODEL_PUBLIC_SELECT } from '../dto/ai-model-public';
import { AiOrchestrator } from './AiOrchestrator';
import { AudioTranscriptionService } from './AudioTranscriptionService';

@UseGuards(ApiAuthGuard)
@ApiTags('Bot Config')
@Controller('bot/config')
export class AiModelController {
  constructor(
    private readonly botConfigService: BotConfigService,
    private readonly orchestrator: AiOrchestrator,
    private readonly prisma: PrismaService,
    @Optional() private readonly audio?: AudioTranscriptionService,
  ) {}

  @Patch(':id/models/:modelId/reset')
  @ApiOperation({
    summary:
      'Reactivar un modelo: limpia contadores, enfriamiento y credencial inválida, y confirma con una llamada de prueba',
  })
  async reactivate(
    @Param('id') id: string,
    @Param('modelId') modelId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.botConfigService.resetModelCounters(id, modelId, user.tenantId);
    const full = await this.prisma.aiModelConfig.findUniqueOrThrow({
      where: { id: modelId },
    });
    const probe =
      full.role === AiModelRole.TRANSCRIPTION && this.audio
        ? await this.audio.probe(full)
        : await this.orchestrator.probe(full);
    const model = await this.prisma.aiModelConfig.findUniqueOrThrow({
      where: { id: modelId },
      select: AI_MODEL_PUBLIC_SELECT,
    });
    return {
      ...model,
      reactivation: probe.ok
        ? { ok: true }
        : {
            ok: false,
            errorType: probe.error.type,
            message: maskSecrets(probe.error.message),
          },
    };
  }
}
