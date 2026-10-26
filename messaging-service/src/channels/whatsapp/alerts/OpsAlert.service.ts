import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageOrchestrator } from 'src/core/orchestrator/MessageOrchestrator';
import { WebhookDispatcher } from 'src/webhooks/WebhookDispatcher';

export type OpsAlertKind = 'connection' | 'undelivered';

interface Batch {
  tenantId: string;
  kind: OpsAlertKind;
  lines: Map<string, number>;
  timer?: NodeJS.Timeout;
}

const DIGEST_WINDOW_MS = 60_000;
const DEDUPE_MS = 10 * 60_000;
const TITLES: Record<OpsAlertKind, string> = {
  connection: 'WhatsApp: problema con la conexión',
  undelivered: 'WhatsApp: respuestas que no pudieron entregarse',
};

/**
 * Avisos para el equipo por canales que no dependen de WhatsApp (que es lo
 * que puede estar caído): webhook `ops.alert` a los endpoints del tenant y
 * correo a OPS_ALERT_EMAILS. Los avisos de varias líneas se agrupan en un
 * solo mensaje; los críticos salen de inmediato y no se repiten en 10 min.
 */
@Injectable()
export class OpsAlertService implements OnModuleDestroy {
  private readonly logger = new Logger(OpsAlertService.name);
  private readonly batches = new Map<string, Batch>();
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly webhooks: WebhookDispatcher,
    private readonly orchestrator: MessageOrchestrator,
  ) {}

  report(
    tenantId: string,
    kind: OpsAlertKind,
    line: string,
    options: { immediate?: boolean; dedupeKey?: string } = {},
  ): void {
    const key = options.dedupeKey ?? `${kind}:${line}`;
    const last = this.lastSent.get(`${tenantId}:${key}`) ?? 0;
    if (options.immediate && Date.now() - last < DEDUPE_MS) return;
    if (options.immediate) this.lastSent.set(`${tenantId}:${key}`, Date.now());

    const batchKey = `${tenantId}:${kind}`;
    let batch = this.batches.get(batchKey);
    if (!batch) {
      batch = { tenantId, kind, lines: new Map() };
      this.batches.set(batchKey, batch);
    }
    batch.lines.set(line, (batch.lines.get(line) ?? 0) + 1);

    if (options.immediate) {
      void this.flush(batchKey);
    } else if (!batch.timer) {
      batch.timer = setTimeout(
        () => void this.flush(batchKey),
        DIGEST_WINDOW_MS,
      );
      batch.timer.unref?.();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.batches.keys()].map((key) => this.flush(key)));
  }

  private async flush(batchKey: string): Promise<void> {
    const batch = this.batches.get(batchKey);
    if (!batch) return;
    this.batches.delete(batchKey);
    if (batch.timer) clearTimeout(batch.timer);

    const lines = [...batch.lines.entries()].map(([text, count]) =>
      count > 1 ? `${text} (x${count})` : text,
    );
    const subject = TITLES[batch.kind];
    const body = `${subject}\n\n${lines.map((l) => `• ${l}`).join('\n')}`;

    const hooks = await this.webhooks.dispatchSystem(
      batch.tenantId,
      'ops.alert',
      { kind: batch.kind, subject, lines },
    );
    const mails = await this.email(batch.tenantId, subject, body);
    if (hooks === 0 && mails === 0) {
      this.logger.error(
        `Aviso "${subject}" sin canal de entrega (sin webhook suscrito a ops.alert ni OPS_ALERT_EMAILS): ${lines.join(' | ')}`,
      );
    }
  }

  private async email(
    tenantId: string,
    subject: string,
    body: string,
  ): Promise<number> {
    const addresses = this.config.get<string[]>('alerts.opsEmails') ?? [];
    let sent = 0;
    for (const address of addresses) {
      try {
        await this.orchestrator.dispatch(tenantId, {
          recipient: { channel: 'EMAIL', address },
          template: { inline: { subject, body } },
          variables: {},
          options: { priority: 'high' },
        });
        sent++;
      } catch (error) {
        this.logger.error(
          `No fue posible enviar el correo de alerta a ${address}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return sent;
  }
}
