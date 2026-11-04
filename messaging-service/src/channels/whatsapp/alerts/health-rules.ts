export interface HealthSnapshot {
  outboxPending: number;
  outboxOldestPendingMs: number;
  queueWaiting: number;
  newDeadLetters: number;
  models: Array<{
    label: string;
    tokensUsedToday: number;
    dailyTokenLimit: number | null;
    circuitOpenUntil: Date | null;
    credentialInvalid: boolean;
  }>;
  now: Date;
}

export interface Finding {
  key: string;
  line: string;
}

export const OUTBOX_STUCK_MS = 5 * 60_000;
export const OUTBOX_BACKLOG = 20;
export const QUEUE_BACKLOG = 100;
export const DAILY_LIMIT_WARN = 0.8;

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** Reglas puras: qué está mal, dado un instante de la salud del servicio. */
export function evaluateHealth(snapshot: HealthSnapshot): Finding[] {
  const findings: Finding[] = [];

  if (
    snapshot.outboxPending >= OUTBOX_BACKLOG ||
    snapshot.outboxOldestPendingMs >= OUTBOX_STUCK_MS
  ) {
    findings.push({
      key: 'outbox',
      line: `${snapshot.outboxPending} respuesta(s) esperando salir; la más antigua lleva ${minutes(snapshot.outboxOldestPendingMs)} min (caducan a los 30)`,
    });
  }

  if (snapshot.queueWaiting >= QUEUE_BACKLOG) {
    findings.push({
      key: 'queue',
      line: `la cola de mensajes crece: ${snapshot.queueWaiting} esperando`,
    });
  }

  if (snapshot.newDeadLetters > 0) {
    findings.push({
      key: 'dlq',
      line: `${snapshot.newDeadLetters} mensaje(s) pasaron a la cola de fallidos y necesitan revisión`,
    });
  }

  for (const model of snapshot.models) {
    if (model.credentialInvalid) {
      findings.push({
        key: `credential:${model.label}`,
        line: `la credencial de ${model.label} fue rechazada; está fuera de uso hasta reactivarla`,
      });
    } else if (
      model.circuitOpenUntil &&
      model.circuitOpenUntil > snapshot.now
    ) {
      findings.push({
        key: `circuit:${model.label}`,
        line: `${model.label} tiene el circuito abierto hasta ${model.circuitOpenUntil.toISOString()}; las respuestas usan el respaldo si existe`,
      });
    }
    if (
      model.dailyTokenLimit &&
      model.tokensUsedToday / model.dailyTokenLimit >= DAILY_LIMIT_WARN
    ) {
      findings.push({
        key: `daily:${model.label}`,
        line: `${model.label} usó ${Math.round((model.tokensUsedToday / model.dailyTokenLimit) * 100)} % de su límite diario de tokens`,
      });
    }
  }

  return findings;
}
