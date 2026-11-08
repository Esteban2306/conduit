import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WhatsAppConnectionStatus } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { BaileysSessionManager } from './baileys/BaileysSessionManager';

type Tx = Prisma.TransactionClient;

interface LineRow {
  id: string;
  key: string | null;
  tenantId: string;
  status: WhatsAppConnectionStatus;
  phoneNumber: string | null;
}

export interface AdoptionCounts {
  contacts: { before: number; after: number };
  optOuts: { before: number; after: number };
  sessionsMoved: number;
  repointed: {
    messages: number;
    botMessages: number;
    conversations: number;
    escalationContacts: number;
    outboundReplies: number;
  };
}

export interface AdoptionResult {
  keptConnectionId: string;
  retiredConnectionId: string;
  counts: AdoptionCounts;
  started: boolean;
}

const RUNNING: WhatsAppConnectionStatus[] = [
  WhatsAppConnectionStatus.CONNECTED,
  WhatsAppConnectionStatus.CONNECTING,
];

@Injectable()
export class LineAdoptionService {
  private readonly logger = new Logger(LineAdoptionService.name);
  private readonly inProgress = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionManager: BaileysSessionManager,
  ) {}

  async adopt(
    tenantId: string,
    keepId: string,
    retireId: string,
    actor?: string,
  ): Promise<AdoptionResult> {
    if (keepId === retireId) {
      throw new BadRequestException(
        'La conexión que se conserva y la que se retira deben ser distintas.',
      );
    }

    const lockKey = `${tenantId}:${[keepId, retireId].sort().join(':')}`;
    if (this.inProgress.has(lockKey)) {
      throw new ConflictException('Ya hay una adopción en curso.');
    }
    this.inProgress.add(lockKey);

    try {
      const [keep, retire] = await this.load(tenantId, keepId, retireId);
      const retireWasConnected =
        retire.status === WhatsAppConnectionStatus.CONNECTED;
      this.assertCompatible(keep, retire, retireWasConnected);

      const wasRunning = [keep, retire]
        .filter((line) => RUNNING.includes(line.status))
        .map((line) => line.id);

      await this.sessionManager.stop(retire.id);
      await this.sessionManager.stop(keep.id);

      let counts: AdoptionCounts;
      try {
        counts = await this.prisma.$transaction(
          (tx) =>
            this.merge(
              tx,
              tenantId,
              keepId,
              retireId,
              retireWasConnected,
              actor,
            ),
          { timeout: 30_000 },
        );
      } catch (error) {
        await this.restart(wasRunning);
        throw error;
      }

      let started = true;
      try {
        await this.sessionManager.start(keepId);
      } catch (error) {
        started = false;
        this.logger.error(
          `Adopción completada pero no se pudo iniciar la sesión de ${keepId}: ${
            error instanceof Error ? error.message : String(error)
          }. Reconéctala con POST whatsapp/connections/${keepId}/connect.`,
        );
      }

      this.logger.log(
        `Conexión ${retireId} adoptada por ${keepId} (tenant ${tenantId}): ` +
          `${counts.contacts.after} contactos, ${counts.optOuts.after} bajas, ` +
          `${counts.sessionsMoved} registros de sesión.`,
      );
      return {
        keptConnectionId: keepId,
        retiredConnectionId: retireId,
        counts,
        started,
      };
    } finally {
      this.inProgress.delete(lockKey);
    }
  }

  private async load(
    tenantId: string,
    keepId: string,
    retireId: string,
    tx: Tx | PrismaService = this.prisma,
  ): Promise<[LineRow, LineRow]> {
    const rows = await tx.whatsAppConnection.findMany({
      where: { tenantId, id: { in: [keepId, retireId] } },
      select: {
        id: true,
        key: true,
        tenantId: true,
        status: true,
        phoneNumber: true,
      },
    });
    const keep = rows.find((row) => row.id === keepId);
    const retire = rows.find((row) => row.id === retireId);
    if (!keep || !retire) {
      throw new NotFoundException(
        'Alguna de las conexiones no existe en este tenant.',
      );
    }
    return [keep, retire];
  }

  private assertCompatible(
    keep: LineRow,
    retire: LineRow,
    retireWasConnected: boolean,
  ): void {
    if (
      keep.status === WhatsAppConnectionStatus.BANNED ||
      retire.status === WhatsAppConnectionStatus.BANNED
    ) {
      throw new BadRequestException(
        'No se adopta una conexión marcada como BANNED.',
      );
    }
    if (!keep.phoneNumber) {
      throw new BadRequestException(
        'La conexión que se conserva no tiene número registrado; no se puede verificar que sea la misma línea.',
      );
    }
    if (retire.phoneNumber) {
      if (retire.phoneNumber !== keep.phoneNumber) {
        throw new BadRequestException(
          'Las dos conexiones tienen números distintos: no son la misma línea.',
        );
      }
      return;
    }
    if (!retireWasConnected) {
      throw new BadRequestException(
        'La conexión a retirar no tiene número registrado y no está conectada; no se puede verificar que sea la misma línea.',
      );
    }
  }

  private async merge(
    tx: Tx,
    tenantId: string,
    keepId: string,
    retireId: string,
    retireWasConnected: boolean,
    actor?: string,
  ): Promise<AdoptionCounts> {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "WhatsAppConnection" WHERE id IN (${Prisma.join([keepId, retireId])}) FOR UPDATE`,
    );

    const [keep, retire] = await this.load(tenantId, keepId, retireId, tx);
    this.assertCompatible(keep, retire, retireWasConnected);

    const retireSessions = await tx.whatsAppSession.count({
      where: { connectionId: retireId },
    });
    if (retireSessions === 0) {
      throw new BadRequestException(
        'La conexión a retirar no tiene credenciales guardadas: no hay nada que adoptar.',
      );
    }

    const before = await this.contactCounts(tx, [keepId, retireId]);

    await tx.whatsAppSession.deleteMany({ where: { connectionId: keepId } });
    const sessions = await tx.whatsAppSession.updateMany({
      where: { connectionId: retireId },
      data: { connectionId: keepId },
    });

    await tx.$executeRaw`
      INSERT INTO "WhatsAppContact"
        ("id", "connectionId", "address", "lid", "lastInboundAt", "onWhatsApp",
         "checkedAt", "optedOutAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${keepId}, r."address", r."lid",
             r."lastInboundAt", r."onWhatsApp", r."checkedAt", r."optedOutAt",
             r."createdAt", now()
      FROM "WhatsAppContact" r
      WHERE r."connectionId" = ${retireId}
      ON CONFLICT ("connectionId", "address") DO UPDATE SET
        "optedOutAt" = LEAST("WhatsAppContact"."optedOutAt", EXCLUDED."optedOutAt"),
        "lastInboundAt" = GREATEST("WhatsAppContact"."lastInboundAt", EXCLUDED."lastInboundAt"),
        "lid" = COALESCE("WhatsAppContact"."lid", EXCLUDED."lid"),
        "onWhatsApp" = CASE
          WHEN "WhatsAppContact"."checkedAt" IS NULL
            OR EXCLUDED."checkedAt" > "WhatsAppContact"."checkedAt"
          THEN COALESCE(EXCLUDED."onWhatsApp", "WhatsAppContact"."onWhatsApp")
          ELSE "WhatsAppContact"."onWhatsApp" END,
        "checkedAt" = GREATEST("WhatsAppContact"."checkedAt", EXCLUDED."checkedAt"),
        "updatedAt" = now()`;
    await tx.whatsAppContact.deleteMany({ where: { connectionId: retireId } });

    const repoint = { where: { connectionId: retireId } };
    const data = { connectionId: keepId };
    const [messages, botMessages, escalationContacts, outboundReplies] =
      await Promise.all([
        tx.message.updateMany({ ...repoint, data }),
        tx.botMessage.updateMany({ ...repoint, data }),
        tx.botEscalationContact.updateMany({ ...repoint, data }),
        tx.outboundReply.updateMany({ ...repoint, data }),
      ]);
    const conversations = await tx.conversation.updateMany({
      where: { lastConnectionId: retireId },
      data: { lastConnectionId: keepId },
    });

    const after = await this.contactCounts(tx, [keepId]);
    if (
      after.contacts !== before.contacts ||
      after.optOuts !== before.optOuts
    ) {
      throw new Error(
        `La verificación de conteos falló (contactos ${before.contacts}→${after.contacts}, ` +
          `bajas ${before.optOuts}→${after.optOuts}); se revierte toda la adopción.`,
      );
    }

    await tx.whatsAppConnection.update({
      where: { id: keepId },
      data: {
        status: WhatsAppConnectionStatus.CONNECTING,
        sessionOwner: null,
        sessionLeaseUntil: null,
        lastQr: null,
        disconnectedAt: null,
      },
    });

    const counts: AdoptionCounts = {
      contacts: { before: before.contacts, after: after.contacts },
      optOuts: { before: before.optOuts, after: after.optOuts },
      sessionsMoved: sessions.count,
      repointed: {
        messages: messages.count,
        botMessages: botMessages.count,
        conversations: conversations.count,
        escalationContacts: escalationContacts.count,
        outboundReplies: outboundReplies.count,
      },
    };

    await tx.whatsAppConnectionAudit.create({
      data: {
        tenantId,
        action: 'ADOPT',
        keptConnectionId: keepId,
        retiredConnectionId: retireId,
        retiredKey: retire.key,
        counts: counts as unknown as Prisma.InputJsonValue,
        actor,
      },
    });

    await tx.whatsAppConnection.delete({ where: { id: retireId } });
    return counts;
  }

  private async contactCounts(
    tx: Tx,
    ids: string[],
  ): Promise<{ contacts: number; optOuts: number }> {
    const [row] = await tx.$queryRaw<
      Array<{ contacts: number; optouts: number }>
    >(
      Prisma.sql`
        SELECT COUNT(DISTINCT "address")::int AS contacts,
               (COUNT(DISTINCT "address") FILTER (WHERE "optedOutAt" IS NOT NULL))::int AS optouts
        FROM "WhatsAppContact"
        WHERE "connectionId" IN (${Prisma.join(ids)})`,
    );
    return { contacts: row?.contacts ?? 0, optOuts: row?.optouts ?? 0 };
  }

  private async restart(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.sessionManager.start(id).catch((error: unknown) => {
        this.logger.error(
          `No se pudo reiniciar ${id} tras una adopción fallida: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }
}
