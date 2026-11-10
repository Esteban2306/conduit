import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { TenantAdminGuard } from 'src/auth/guards/tenant-admin.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import {
  LegacyImageUsageService,
  MAX_WINDOW_DAYS,
} from './LegacyImageUsage.service';

@UseGuards(ApiAuthGuard, TenantAdminGuard)
@ApiTags('Specialists')
@Controller('image-analysis')
export class LegacyImageUsageController {
  constructor(private readonly usage: LegacyImageUsageService) {}

  @Get('legacy-usage')
  @ApiOperation({
    summary:
      'Uso del análisis de imagen antiguo por bot (para decidir cuándo retirarlo)',
  })
  summary(@CurrentUser() user: JwtPayload, @Query('days') days?: string) {
    let window: number | undefined;
    if (days !== undefined) {
      window = Number(days);
      if (!Number.isInteger(window) || window < 1 || window > MAX_WINDOW_DAYS) {
        throw new BadRequestException(
          `days debe ser un entero entre 1 y ${MAX_WINDOW_DAYS}.`,
        );
      }
    }
    return this.usage.summary(user.tenantId, window);
  }
}
