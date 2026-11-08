import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { SystemPauseService } from './SystemPause.service';

export class SetSystemPauseDto {
  @IsBoolean()
  paused: boolean;
}

@UseGuards(ApiAuthGuard)
@ApiTags('System Pause')
@Controller('system/pause')
export class SystemPauseController {
  constructor(private readonly pause: SystemPauseService) {}

  @Get()
  @ApiOperation({
    summary: 'Estado de la pausa del sistema de la empresa',
  })
  get(@CurrentUser() user: JwtPayload) {
    return this.pause.get(user.tenantId);
  }

  @Put()
  @ApiOperation({
    summary:
      'Pausa o reanuda las respuestas automáticas (bot y avisos) sin desconectar WhatsApp',
  })
  set(@CurrentUser() user: JwtPayload, @Body() dto: SetSystemPauseDto) {
    return this.pause.set(user.tenantId, dto.paused);
  }
}
