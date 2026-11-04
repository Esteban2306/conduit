import { Injectable } from '@nestjs/common';
import type { proto } from '@whiskeysockets/baileys';
import { PrismaService } from 'src/shared/prisma.service';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * Mensajes enviados recientemente, por id de WhatsApp. Baileys los pide
 * (`getMessage`) cuando el teléfono del destinatario no pudo descifrar un
 * mensaje y solicita reenviarlo. Sin esto, el cliente ve "Esperando este
 * mensaje" y los reintentos fallidos de cifrado se acumulan en la sesión.
 *
 * Memoria primero (cubre los reintentos, que llegan en segundos o minutos);
 * para mensajes de plantilla hay respaldo en la tabla Message tras reinicios.
 */
@Injectable()
export class SentMessageStore {
  private readonly entries = new Map<
    string,
    { message: proto.IMessage; at: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  remember(id: string, message: proto.IMessage | null | undefined): void {
    if (!id || !message) return;
    this.entries.set(id, { message, at: Date.now() });

    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest) this.entries.delete(oldest);
    }
  }

  async find(
    id: string | null | undefined,
  ): Promise<proto.IMessage | undefined> {
    if (!id) return undefined;

    const entry = this.entries.get(id);
    if (entry && Date.now() - entry.at < TTL_MS) return entry.message;
    if (entry) this.entries.delete(id);

    const persisted = await this.prisma.message.findFirst({
      where: { providerMessageId: id },
      select: { renderedBody: true },
    });
    return persisted?.renderedBody
      ? { conversation: persisted.renderedBody }
      : undefined;
  }
}
