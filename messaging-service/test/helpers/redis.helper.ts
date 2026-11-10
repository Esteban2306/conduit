import { Queue, QueueEvents } from 'bullmq';

export interface RedisConnection {
  host: string;
  port: number;
  password?: string;
}

export async function clearQueue(
  queueName: string,
  connection: RedisConnection,
): Promise<void> {
  const queue = new Queue(queueName, { connection });
  await queue.obliterate({ force: true });
  await queue.close();
}

export async function finished(
  events: QueueEvents,
  queue: Queue,
  jobId: string,
  timeoutMs = 10000,
): Promise<{ success: boolean; error?: string }> {
  const job = await queue.getJob(jobId);
  if (!job) throw new Error(`El job ${jobId} no existe en la cola`);
  try {
    await job.waitUntilFinished(events, timeoutMs);
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
