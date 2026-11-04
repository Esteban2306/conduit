import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OutboundReplyStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from 'src/queue/queues';
import { PrismaService } from 'src/shared/prisma.service';
import { evaluateHealth, HealthSnapshot } from './health-rules';
import { OpsAlertService } from './OpsAlert.service';

const CHECK_EVERY_MS = 60_000;
const REPEAT_EVERY_MS = 30 * 60_000;

/**
 * Revisa cada minuto la salud del servicio y avisa de lo que necesita a una
 * persona: respuestas atascadas, cola creciente, mensajes fallidos, límite
 * diario de IA cerca y modelos fuera de uso. Cada condición se repite como
 * mucho cada 30 minutos mientras siga ocurriendo.
 */
@Injectable()
export class OpsWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpsWatchdogService.name);
  private timer: NodeJS.Timeout | null = null;
  private lastDeadLetterCheck = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: OpsAlertService,
    @InjectQueue(QUEUE_NAMES.MESSAGES) private readonly messages: Queue,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<number> {
    try {
      const tenants = await this.tenantIds();
      if (tenants.length === 0) return 0;
      const snapshot = await this.snapshot();
      const findings = evaluateHealth(snapshot);
      for (const finding of findings) {
        for (const tenantId of tenants) {
          this.alerts.report(tenantId, 'capacity', finding.line, {
            immediate: true,
            dedupeKey: finding.key,
            dedupeMs: REPEAT_EVERY_MS,
          });
        }
      }
      return findings.length;
    } catch (error) {
      this.logger.warn(
        `No se pudo revisar la salud del servicio: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  private async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.whatsAppConnection.findMany({
      distinct: ['tenantId'],
      select: { tenantId: true },
    });
    return rows.map((r) => r.tenantId);
  }

  private async snapshot(): Promise<HealthSnapshot> {
    const now = new Date();
    const since = this.lastDeadLetterCheck;
    this.lastDeadLetterCheck = now;

    const [pending, oldest, counts, deadLetters, models] = await Promise.all([
      this.prisma.outboundReply.count({
        where: { status: OutboundReplyStatus.PENDING },
      }),
      this.prisma.outboundReply.findFirst({
        where: { status: OutboundReplyStatus.PENDING },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.messages.getJobCounts('waiting'),
      this.prisma.deadLetterMessage.count({
        where: { createdAt: { gt: since } },
      }),
      this.prisma.aiModelConfig.findMany({
        where: { isActive: true },
        select: {
          provider: true,
          model: true,
          tokensUsedToday: true,
          dailyTokenLimit: true,
          unavailableUntil: true,
          credentialInvalidAt: true,
        },
      }),
    ]);

    return {
      outboxPending: pending,
      outboxOldestPendingMs: oldest
        ? now.getTime() - oldest.createdAt.getTime()
        : 0,
      queueWaiting: counts.waiting ?? 0,
      newDeadLetters: deadLetters,
      models: models.map((m) => ({
        label: `${m.provider}/${m.model}`,
        tokensUsedToday: m.tokensUsedToday,
        dailyTokenLimit: m.dailyTokenLimit,
        circuitOpenUntil: m.unavailableUntil,
        credentialInvalid: m.credentialInvalidAt !== null,
      })),
      now,
    };
  }
}
