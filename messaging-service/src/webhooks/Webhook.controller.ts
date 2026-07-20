import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtGuard } from 'src/auth/guards/jwt-auth.guard';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/types/jwt.types';
import { WebhookService } from './Webhook.service';
import { CreateWebhookDto } from './dto/CreateWebhook.dto';

@UseGuards(JwtGuard)
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly service: WebhookService) {}

  @Post()
  create(@Body() dto: CreateWebhookDto, @CurrentUser() user: JwtPayload) {
    return this.service.createWebhook(user.tenantId, dto);
  }

  @Get()
  findAll(@CurrentUser() user: JwtPayload) {
    return this.service.findAll(user.tenantId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.remove(id, user.tenantId);
  }

  @Get(':id/deliveries')
  getDeliveries(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.getDeliveries(id, user.tenantId);
  }
}
