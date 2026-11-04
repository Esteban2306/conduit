import { Injectable } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from 'src/shared/prisma.service';
import { HmacSignatureGuardBase } from 'src/shared/security/hmac/hmac-signature.guard.base';
import {
  ResolvedSignatureSecret,
  SignatureSecretResolver,
} from 'src/shared/security/hmac/signature-secret-resolver.interface';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';

@Injectable()
export class ExternalIntegrationSecretResolver implements SignatureSecretResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: SecretEncryptionService,
  ) {}

  async resolve(
    integrationId: string,
    request: Request,
  ): Promise<ResolvedSignatureSecret | null> {
    const integration = await this.prisma.externalIntegration.findFirst({
      where: { id: integrationId, isActive: true },
      select: {
        id: true,
        secretEncrypted: true,
        botConfigId: true,
        tenantId: true,
      },
    });

    if (!integration) return null;

    const botIdFromRoute = request.params?.botId;

    if (botIdFromRoute && botIdFromRoute !== integration.botConfigId) {
      return null;
    }

    return {
      secret: this.encryption.decrypt(integration.secretEncrypted),
      context: {
        integrationId: integration.id,
        botConfigId: integration.botConfigId,
        tenantId: integration.tenantId,
      },
    };
  }

  async onVerified(integrationId: string): Promise<void> {
    await this.prisma.externalIntegration.update({
      where: { id: integrationId },
      data: { lastUsedAt: new Date() },
    });
  }
}

@Injectable()
export class ExternalIntegrationSignatureGuard extends HmacSignatureGuardBase {
  constructor(resolver: ExternalIntegrationSecretResolver) {
    super(resolver);
  }
}
