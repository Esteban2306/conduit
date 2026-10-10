import type { Worker } from 'bullmq';

const DEFAULT_GRACE_MS = 5_000;

/**
 * Cierra un worker dando un margen para que terminen los jobs activos.
 * Los envíos de WhatsApp pueden pasar horas esperando dentro del rate
 * limiter (fuera de horario, tope diario), así que esperar sin límite
 * colgaría el apagado. Tras el margen se fuerza el cierre: BullMQ marca
 * esos jobs como "stalled" y los retoma al arrancar.
 */
export async function closeWorkerGracefully(
  worker: Worker | undefined,
  graceMs = DEFAULT_GRACE_MS,
): Promise<void> {
  if (!worker) return;

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), graceMs);
  });

  const result = await Promise.race([
    worker.close().then(() => 'closed' as const),
    timedOut,
  ]);
  clearTimeout(timer);

  if (result === 'timeout') await worker.close(true);
}
