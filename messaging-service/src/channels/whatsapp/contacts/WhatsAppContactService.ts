import { Injectable, Logger } from '@nestjs/common';
import { WhatsAppCampaignPolicy } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';

/** Cuánto vale un "sí tiene WhatsApp" antes de volver a consultar. */
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Un "no tiene WhatsApp" se re-verifica antes: la persona pudo instalarlo. */
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CampaignGateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Contactos de cada conexión de WhatsApp.
 *
 * - Registra quién escribió (base de la política anti-baneo: el negocio
 *   solo inicia conversación con quien ya le escribió).
 * - Cachea si un número tiene WhatsApp: consultarlo antes de cada envío
 *   es, en sí mismo, un patrón de enumeración que WhatsApp vigila.
 */
@Injectable()
export class WhatsAppContactService {
  private readonly logger = new Logger(WhatsAppContactService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Contactos de la conexión, más recientes primero (para el panel). */
  async list(
    connectionId: string,
    options: { search?: string; page?: number; limit?: number } = {},
  ) {
    const page = Math.max(options.page ?? 1, 1);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const where = {
      connectionId,
      ...(options.search && { address: { contains: options.search } }),
    };
    const [data, total] = await Promise.all([
      this.prisma.whatsAppContact.findMany({
        where,
        orderBy: [{ lastInboundAt: { sort: 'desc', nulls: 'last' } }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          address: true,
          lastInboundAt: true,
          onWhatsApp: true,
          checkedAt: true,
        },
      }),
      this.prisma.whatsAppContact.count({ where }),
    ]);
    return { data, meta: { total, page, limit } };
  }

  /** El contacto escribió: existe en WhatsApp y queda habilitado. */
  async recordInbound(
    connectionId: string,
    address: string,
    lid?: string | null,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.whatsAppContact.upsert({
      where: { connectionId_address: { connectionId, address } },
      create: {
        connectionId,
        address,
        lid: lid ?? null,
        lastInboundAt: now,
        onWhatsApp: true,
        checkedAt: now,
      },
      update: {
        lastInboundAt: now,
        onWhatsApp: true,
        checkedAt: now,
        ...(lid && { lid }),
      },
    });
  }

  /** Teléfono conocido para un LID visto antes en esta conexión. */
  async findAddressByLid(
    connectionId: string,
    lid: string,
  ): Promise<string | null> {
    const contact = await this.prisma.whatsAppContact.findFirst({
      where: { connectionId, lid },
      select: { address: true },
    });
    return contact?.address ?? null;
  }

  /** `true`/`false` si hay un dato vigente; `null` si hay que consultar. */
  async cachedExistence(
    connectionId: string,
    address: string,
  ): Promise<boolean | null> {
    const contact = await this.prisma.whatsAppContact.findUnique({
      where: { connectionId_address: { connectionId, address } },
      select: { onWhatsApp: true, checkedAt: true },
    });
    if (contact?.onWhatsApp == null || !contact.checkedAt) return null;

    const ttl = contact.onWhatsApp ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    return Date.now() - contact.checkedAt.getTime() < ttl
      ? contact.onWhatsApp
      : null;
  }

  async saveExistence(
    connectionId: string,
    address: string,
    exists: boolean,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.whatsAppContact.upsert({
      where: { connectionId_address: { connectionId, address } },
      create: { connectionId, address, onWhatsApp: exists, checkedAt: now },
      update: { onWhatsApp: exists, checkedAt: now },
    });
  }

  /**
   * ¿Puede el negocio iniciar un mensaje (recordatorio, aviso, campaña) a
   * este número? Con la política INBOUND_ONLY, solo si escribió dentro de
   * la ventana configurada en la conexión.
   */
  async campaignGate(
    connectionId: string,
    address: string,
  ): Promise<CampaignGateResult> {
    const connection = await this.prisma.whatsAppConnection.findUnique({
      where: { id: connectionId },
      select: { campaignPolicy: true, inboundLookbackDays: true },
    });
    if (!connection) {
      return { allowed: false, reason: 'La conexión no existe' };
    }
    if (connection.campaignPolicy === WhatsAppCampaignPolicy.ANY) {
      return { allowed: true };
    }

    const contact = await this.prisma.whatsAppContact.findUnique({
      where: { connectionId_address: { connectionId, address } },
      select: { lastInboundAt: true },
    });

    const since =
      Date.now() - connection.inboundLookbackDays * 24 * 60 * 60 * 1000;
    if (contact?.lastInboundAt && contact.lastInboundAt.getTime() >= since) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: contact?.lastInboundAt
        ? `El número ${address} no ha escrito en los últimos ${connection.inboundLookbackDays} días`
        : `El número ${address} nunca le ha escrito a este WhatsApp`,
    };
  }
}
