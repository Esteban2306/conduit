import { Queue, Worker, QueueEvents } from 'bullmq';

export const TEST_REDIS = {
  host: 'localhost',
  port: 6380,
};

export async function clearQueue(queueName: string): Promise<void> {
  const queue = new Queue(queueName, { connection: TEST_REDIS });
  await queue.obliterate({ force: true });
  await queue.close();
}

export function waitForJob(
  queueName: string,
  timeoutMs = 10000,
): Promise<{
  jobId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}> {
  return new Promise((res, rej) => {
    const events = new QueueEvents(queueName, { connection: TEST_REDIS });
    const timeout = setTimeout(() => {
      events.close();
      rej(new Error(`Timeout waiting job on queue ${queueName}`));
    }, timeoutMs);

    events.on('completed', ({ jobId, returnvalue }) => {
      clearTimeout(timeout);
      events.close();
      res({ jobId, success: true, data: returnvalue });
    });

    events.on('failed', ({ jobId, failedReason }) => {
      clearTimeout(timeout);
      events.close();
      res({ jobId, success: false, error: failedReason });
    });
  });
}
