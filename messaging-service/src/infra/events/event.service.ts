import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';

import { DomainEvent } from './interface/event.interface';
import { EventPayloadMap, EventType } from './constants/event.types';

@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  publish<K extends EventType>(
    type: K,
    payload: EventPayloadMap[K],
    options?: {
      correlationId?: string;
      tenantId?: string;
    },
  ): void {
    const event: DomainEvent<EventPayloadMap[K]> = {
      type,
      timestamp: new Date(),
      correlationId: options?.correlationId ?? randomUUID(),
      tenantId: options?.tenantId,
      payload,
    };

    this.logger.debug(`[EVENT] ${type} | ${event.correlationId}`);

    this.eventEmitter.emit(type, event);
  }

  async publishAsync<K extends EventType>(
    type: K,
    payload: EventPayloadMap[K],
    options?: {
      correlationId?: string;
      tenantId?: string;
    },
  ): Promise<boolean[]> {
    const event: DomainEvent<EventPayloadMap[K]> = {
      type,
      timestamp: new Date(),
      correlationId: options?.correlationId ?? randomUUID(),
      tenantId: options?.tenantId,
      payload,
    };

    return this.eventEmitter.emitAsync(type, event);
  }
}
