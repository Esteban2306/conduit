import { Injectable, NotFoundException } from '@nestjs/common';
import { BotConfigService } from 'src/bot/config/BotConfigService';
import { PrismaService } from 'src/shared/prisma.service';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { CreateExternalIntegrationDto } from './dto/create-external-integration.dto';

@Injectable()
export class ExternalIntegrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: SecretEncryptionService,
    private readonly botConfigService: BotConfigService,
  ) {}

  async create(
    botConfigId: string,
    tenantId: string,
    dto: CreateExternalIntegrationDto,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);

    const plainSecret = this.encryption.generateSecret();
    const secretEncrypted = this.encryption.encrypt(plainSecret);

    const integration = await this.prisma.externalIntegration.create({
      data: { tenantId, botConfigId, name: dto.name, secretEncrypted },
      select: { id: true, name: true, isActive: true, createdAt: true },
    });

    return { ...integration, secret: plainSecret };
  }

  async findAll(botConfigId: string, tenantId: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);

    return this.prisma.externalIntegration.findMany({
      where: { botConfigId },
      select: {
        id: true,
        name: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(botConfigId: string, integrationId: string, tenantId: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);

    const { count } = await this.prisma.externalIntegration.updateMany({
      where: { id: integrationId, botConfigId },
      data: { isActive: false },
    });

    if (!count) throw new NotFoundException('Integración no encontrada.');
  }
}
