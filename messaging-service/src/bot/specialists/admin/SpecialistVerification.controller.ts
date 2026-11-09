import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Body,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { TenantAdminGuard } from 'src/auth/guards/tenant-admin.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { SpecialistMetricsService } from './SpecialistMetricsService';
import {
  DRY_RUN_MAX_IMAGE_BYTES,
  SpecialistVerificationService,
} from './SpecialistVerificationService';

@UseGuards(ApiAuthGuard)
@ApiTags('Specialists')
@Controller()
export class SpecialistVerificationController {
  constructor(
    private readonly verifications: SpecialistVerificationService,
    private readonly metrics: SpecialistMetricsService,
  ) {}

  @Get('verifications/metrics')
  @ApiOperation({
    summary:
      'Métricas agregadas de verificaciones: veredictos, latencia, motivos, reutilización, tokens y costo',
  })
  summary(@CurrentUser() user: JwtPayload, @Query() query: unknown) {
    return this.metrics.summary(user.tenantId, query);
  }

  @Get('verifications')
  @ApiOperation({
    summary: 'Consultar verificaciones con filtros y paginación (sin imágenes)',
  })
  list(@CurrentUser() user: JwtPayload, @Query() query: unknown) {
    return this.verifications.list(user.tenantId, query);
  }

  @Get('verifications/:id')
  @ApiOperation({ summary: 'Ver una verificación' })
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.verifications.get(user.tenantId, id);
  }

  @UseGuards(TenantAdminGuard)
  @Post('verifications/:id/review')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Registrar la decisión de una persona sobre un resultado dudoso. Solo deja constancia: no habilita herramientas ni cambia el veredicto',
  })
  review(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.verifications.review(user.tenantId, user.sub, id, body);
  }

  @UseGuards(TenantAdminGuard)
  @Post('specialists/:id/dry-run')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Probar un especialista con una imagen sin guardar nada; admite un borrador del prompt o las reglas',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: DRY_RUN_MAX_IMAGE_BYTES, files: 1 },
    }),
  )
  dryRun(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { draft?: unknown } | undefined,
  ) {
    return this.verifications.dryRun(user.tenantId, id, file, body?.draft);
  }
}
