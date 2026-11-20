import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { BotConfigService } from '../config/BotConfigService';
import {
  MutedContactService,
  normalizeMutedAddress,
} from './MutedContact.service';

export class MuteContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

@UseGuards(ApiAuthGuard)
@ApiTags('Bot conversations')
@Controller('bots/:botId/muted-contacts')
export class MutedContactsController {
  constructor(
    private readonly bots: BotConfigService,
    private readonly muted: MutedContactService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Contactos a los que el bot nunca responde' })
  async list(
    @Param('botId', ParseUUIDPipe) botId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.bots.findOne(botId, user.tenantId);
    return this.muted.list(botId);
  }

  @Put(':address')
  @ApiOperation({
    summary:
      'Silenciar un contacto: sus mensajes se guardan pero el bot nunca responde',
  })
  async mute(
    @Param('botId', ParseUUIDPipe) botId: string,
    @Param('address') rawAddress: string,
    @Body() dto: MuteContactDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.bots.findOne(botId, user.tenantId);
    const address = this.address(rawAddress);
    return this.muted.mute(
      user.tenantId,
      botId,
      address,
      dto.reason?.trim() || null,
    );
  }

  @Delete(':address')
  @ApiOperation({ summary: 'Quitar el silencio de un contacto' })
  async unmute(
    @Param('botId', ParseUUIDPipe) botId: string,
    @Param('address') rawAddress: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.bots.findOne(botId, user.tenantId);
    const address = this.address(rawAddress);
    if (!(await this.muted.unmute(botId, address))) {
      throw new NotFoundException('El contacto no está silenciado');
    }
    return { address, muted: false };
  }

  private address(raw: string): string {
    const address = normalizeMutedAddress(decodeURIComponent(raw));
    if (!address) {
      throw new BadRequestException(
        'Dirección inválida: usa el número con código de país o la dirección <lid>@lid',
      );
    }
    return address;
  }
}
