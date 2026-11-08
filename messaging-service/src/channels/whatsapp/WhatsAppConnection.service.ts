import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  WhatsAppCampaignPolicy,
  WhatsAppConnectionStatus,
  WhatsAppWarmupLevel,
} from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { CreateWhatsAppConnectionDto } from './dto/create-whatsapp-connection.dto';
import { resolveUniqueKey, slugifyKey } from 'src/shared/stable-key';
import * as QRCode from 'qrcode';

@Injectable()
export class WhatsAppConnectionService {
  private readonly logger = new Logger(WhatsAppConnectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateWhatsAppConnectionDto) {
    const key = await this.resolveKey(tenantId, dto.key, dto.name);

    try {
      return await this.prisma.$transaction(async (tx) => {
        let botConfigId: string | undefined;
        if (dto.botConfigId) {
          const botConfig = await tx.botConfig.findFirst({
            where: { id: dto.botConfigId, tenantId },
            select: { id: true },
          });
          if (!botConfig) {
            throw new NotFoundException(
              'BotConfig no encontrado para este tenant.',
            );
          }
          botConfigId = botConfig.id;
        }

        return tx.whatsAppConnection.create({
          data: {
            tenantId,
            key,
            botConfigId,
            name: dto.name,
            status: WhatsAppConnectionStatus.DISCONNECTED,
            warmupLevel: dto.warmupLevel ?? WhatsAppWarmupLevel.NORMAL,
          },
        });
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          `Ya existe una conexión con la clave "${key}" en este tenant.`,
        );
      }
      throw err;
    }
  }

  async findByKey(key: string, tenantId: string) {
    const connection = await this.prisma.whatsAppConnection.findFirst({
      where: { tenantId, key },
    });
    if (!connection) {
      throw new NotFoundException(`Conexión con clave "${key}" no encontrada.`);
    }
    return connection;
  }

  private async resolveKey(
    tenantId: string,
    requested: string | undefined,
    name: string,
  ): Promise<string> {
    const taken = async (candidate: string) =>
      (await this.prisma.whatsAppConnection.count({
        where: { tenantId, key: candidate },
      })) > 0;

    if (requested) {
      if (await taken(requested)) {
        throw new ConflictException(
          `Ya existe una conexión con la clave "${requested}" en este tenant.`,
        );
      }
      return requested;
    }
    return resolveUniqueKey(slugifyKey(name, 'line'), taken);
  }

  async assignBotConfig(id: string, tenantId: string, botConfigId: string) {
    const connection = await this.findOne(id, tenantId);

    const botConfig = await this.prisma.botConfig.findFirst({
      where: { id: botConfigId, tenantId },
      select: { id: true },
    });

    if (!botConfig) {
      throw new NotFoundException('BotConfig no encontrado para este tenant.');
    }

    return this.prisma.whatsAppConnection.update({
      where: { id: connection.id },
      data: { botConfigId },
    });
  }

  async unassignBotConfig(id: string, tenantId: string) {
    await this.findOne(id, tenantId);
    return this.prisma.whatsAppConnection.update({
      where: { id },
      data: { botConfigId: null },
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

  /**
   * Toma (o renueva) el lease de la sesión para `owner`. Solo una instancia
   * de Conduit puede tener abierto el socket de una conexión: dos sockets
   * con las mismas credenciales se expulsan mutuamente (código 440) en
   * bucle, un patrón que WhatsApp asocia a cuentas automatizadas.
   *
   * @returns null si se obtuvo; si no, hasta cuándo lo tiene otro dueño.
   */
  async acquireSessionLease(
    id: string,
    owner: string,
    ttlMs: number,
  ): Promise<Date | null> {
    const now = new Date();
    const { count } = await this.prisma.whatsAppConnection.updateMany({
      where: {
        id,
        OR: [
          { sessionOwner: null },
          { sessionOwner: owner },
          { sessionLeaseUntil: null },
          { sessionLeaseUntil: { lt: now } },
        ],
      },
      data: {
        sessionOwner: owner,
        sessionLeaseUntil: new Date(now.getTime() + ttlMs),
      },
    });
    if (count > 0) return null;

    const current = await this.prisma.whatsAppConnection.findUnique({
      where: { id },
      select: { sessionLeaseUntil: true },
    });
    return current?.sessionLeaseUntil ?? new Date(now.getTime() + ttlMs);
  }

  async updateCampaignPolicy(
    id: string,
    tenantId: string,
    policy: WhatsAppCampaignPolicy,
    inboundLookbackDays?: number,
  ) {
    await this.findOne(id, tenantId);
    return this.prisma.whatsAppConnection.update({
      where: { id },
      data: {
        campaignPolicy: policy,
        ...(inboundLookbackDays !== undefined && { inboundLookbackDays }),
      },
      select: { id: true, campaignPolicy: true, inboundLookbackDays: true },
    });
  }

  async releaseSessionLease(id: string, owner: string): Promise<void> {
    await this.prisma.whatsAppConnection.updateMany({
      where: { id, sessionOwner: owner },
      data: { sessionOwner: null, sessionLeaseUntil: null },
    });
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

  async updateWarmupLevel(
    id: string,
    tenantId: string,
    warmupLevel: WhatsAppWarmupLevel,
  ) {
    const { count } = await this.prisma.whatsAppConnection.updateMany({
      where: { id, tenantId },
      data: { warmupLevel },
    });
    if (!count)
      throw new NotFoundException('Conexión de WhatsApp no encontrada.');
    return this.prisma.whatsAppConnection.findUniqueOrThrow({ where: { id } });
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

  async markConnected(id: string, phoneNumber: string | null) {
    const base = {
      status: WhatsAppConnectionStatus.CONNECTED,
      connectedAt: new Date(),
      disconnectedAt: null,
      lastQr: null,
    };

    try {
      return await this.prisma.whatsAppConnection.update({
        where: { id },
        data: { ...base, phoneNumber },
      });
    } catch (err) {
      if (
        phoneNumber &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.error(
          `El número ${phoneNumber} ya está registrado en otra conexión del mismo tenant; ` +
            `la conexión ${id} queda conectada sin guardar el número. ` +
            `Desvincula o reemplaza la otra conexión.`,
        );
        return this.prisma.whatsAppConnection.update({
          where: { id },
          data: base,
        });
      }
      throw err;
    }
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
