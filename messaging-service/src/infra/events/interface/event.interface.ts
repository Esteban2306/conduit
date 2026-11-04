export interface DomainEvent<T = unknown> {
  type: string;

  timestamp: Date;

  correlationId: string;

  tenantId?: string;

  payload: T;
}
