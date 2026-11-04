import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { messageJobDefaults, QUEUE_NAMES } from './queues';

/**
 * Registro único de las colas de mensajes. Cada módulo que las inyecta
 * obtiene su propia instancia de `Queue`, por eso las opciones por defecto
 * deben vivir aquí y no repetirse a mano en cada `registerQueue`.
 */
export function registerMessageQueues() {
  return BullModule.registerQueueAsync(
    {
      name: QUEUE_NAMES.MESSAGES,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        defaultJobOptions: messageJobDefaults(config),
      }),
    },
    {
      name: QUEUE_NAMES.MESSAGES_SCHEDULED,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        defaultJobOptions: messageJobDefaults(config, {
          removeOnComplete: { count: 100 },
        }),
      }),
    },
    {
      name: QUEUE_NAMES.DEAD_LETTER,
      useFactory: () => ({
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      }),
    },
  );
}
