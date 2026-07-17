import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WhatsAppConnectionStatus } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { CreateWhatsAppConnectionDto } from './dto/create-whatsapp-connection.dto';
import * as QRCode from 'qrcode';

@Injectable()
export class WhatsAppConnectionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateWhatsAppConnectionDto) {
    return this.prisma.$transaction(async (tx) => {
      const botConfig = await tx.botConfig.findFirst({
        where: { id: dto.botConfigId, tenantId },
        select: { id: true },
      });
      if (!botConfig) {
        throw new NotFoundException(
          'BotConfig no encontrado para este tenant.',
        );
      }

      return tx.whatsAppConnection.create({
        data: {
          tenantId,
          botConfigId: botConfig.id,
          name: dto.name,
          status: WhatsAppConnectionStatus.DISCONNECTED,
        },
      });
    });
  }

  findAll(tenantId: string) {
    return this.prisma.whatsAppConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findOne(id: string, tenantId: string) {
    const connection = await this.prisma.whatsAppConnection.findFirst({
      where: { id, tenantId },
    });
    if (!connection)
      throw new NotFoundException('Conexión de WhatsApp no encontrada.');
    return connection;
  }

  findForSessionManager(id: string) {
    return this.prisma.whatsAppConnection.findUnique({ where: { id } });
  }

  findConnectionsToRestore() {
    return this.prisma.whatsAppConnection.findMany({
      where: {
        status: {
          in: [
            WhatsAppConnectionStatus.CONNECTED,
            WhatsAppConnectionStatus.CONNECTING,
          ],
        },
      },
      select: { id: true },
    });
  }

  async connect(id: string, tenantId: string) {
    return this.updateStatusForTenant(
      id,
      tenantId,
      WhatsAppConnectionStatus.CONNECTING,
    );
  }

  async disconnect(id: string, tenantId: string) {
    return this.updateStatusForTenant(
      id,
      tenantId,
      WhatsAppConnectionStatus.DISCONNECTED,
      { disconnectedAt: new Date() },
    );
  }

  async restart(id: string, tenantId: string) {
    return this.updateStatusForTenant(
      id,
      tenantId,
      WhatsAppConnectionStatus.CONNECTING,
      { disconnectedAt: null },
    );
  }

  async delete(id: string, tenantId: string) {
    const { count } = await this.prisma.whatsAppConnection.deleteMany({
      where: { id, tenantId },
    });
    if (!count)
      throw new NotFoundException('Conexión de WhatsApp no encontrada.');
  }

  updateStatus(
    id: string,
    status: WhatsAppConnectionStatus,
    data: Prisma.WhatsAppConnectionUpdateInput = {},
  ) {
    return this.prisma.whatsAppConnection.update({
      where: { id },
      data: { ...data, status },
    });
  }

  updatePhone(id: string, phoneNumber: string | null) {
    return this.prisma.whatsAppConnection.update({
      where: { id },
      data: { phoneNumber },
    });
  }

  async updateQR(connectionId: string, qrString: string): Promise<void> {
    const qrImageBase64 = await QRCode.toDataURL(qrString, {
      errorCorrectionLevel: 'M',
      width: 300,
      margin: 2,
    });

    await this.prisma.whatsAppConnection.update({
      where: { id: connectionId },
      data: {
        lastQr: qrImageBase64,
        status: 'CONNECTING',
        updatedAt: new Date(),
      },
    });
  }

  markConnected(id: string, phoneNumber: string | null) {
    return this.prisma.whatsAppConnection.update({
      where: { id },
      data: {
        status: WhatsAppConnectionStatus.CONNECTED,
        phoneNumber,
        connectedAt: new Date(),
        disconnectedAt: null,
        lastQr: null,
      },
    });
  }

  private async updateStatusForTenant(
    id: string,
    tenantId: string,
    status: WhatsAppConnectionStatus,
    data: Prisma.WhatsAppConnectionUpdateManyMutationInput = {},
  ) {
    const { count } = await this.prisma.whatsAppConnection.updateMany({
      where: { id, tenantId },
      data: { ...data, status },
    });
    if (!count)
      throw new NotFoundException('Conexión de WhatsApp no encontrada.');
    return this.prisma.whatsAppConnection.findUniqueOrThrow({ where: { id } });
  }
}
