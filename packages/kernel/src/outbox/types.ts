export interface DomainEvent<P = unknown> {
  messageId: string;      // ULID — unique per event; downstream consumers dedupe on it
  aggregateType: string;
  aggregateId: string;
  type: string;
  version: number;
  tenantId: string;
  payload: P;
  occurredAt: Date;
}

export interface OutboxRow {
  messageId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  routingKey: string;
  payload: unknown;
  headers: { tenantId: string; correlationId: string | undefined };
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  attempts: number;
  availableAt: Date;
  occurredAt: Date;
}
