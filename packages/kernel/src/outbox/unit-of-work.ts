import type {
  ClientSession,
  Collection,
  Db,
  Document,
  Filter,
  FindOneAndUpdateOptions,
  MongoClient,
  OptionalUnlessRequiredId,
  UpdateFilter,
} from 'mongodb';
import { RequestContext } from '../context/request-context.js';
import type { DomainEvent, OutboxRow } from './types.js';

/** Every operation is bound to the transaction's session, so a use case
 *  cannot accidentally write outside the transaction by forgetting to pass
 *  { session } — the mistake that made the first version of this file
 *  silently not roll back on failure. */
export class SessionBoundCollection<T extends Document> {
  constructor(
    private readonly col: Collection<T>,
    private readonly session: ClientSession,
  ) {}

  insertOne(doc: OptionalUnlessRequiredId<T>) {
    return this.col.insertOne(doc, { session: this.session });
  }

  insertMany(docs: OptionalUnlessRequiredId<T>[]) {
    return this.col.insertMany(docs, { session: this.session, ordered: true });
  }

  updateOne(filter: Filter<T>, update: UpdateFilter<T>) {
    return this.col.updateOne(filter, update, { session: this.session });
  }

  findOne(filter: Filter<T> = {}) {
    return this.col.findOne(filter, { session: this.session });
  }

  find(filter: Filter<T> = {}) {
    return this.col.find(filter, { session: this.session });
  }

  findOneAndUpdate(filter: Filter<T>, update: UpdateFilter<T>, options: FindOneAndUpdateOptions = {}) {
    return this.col.findOneAndUpdate(filter, update, { ...options, session: this.session });
  }

  deleteOne(filter: Filter<T>) {
    return this.col.deleteOne(filter, { session: this.session });
  }
}

export class UnitOfWork {
  constructor(
    private readonly db: Db,
    readonly session: ClientSession,
  ) {}

  collection<T extends Document = Document>(name: string): SessionBoundCollection<T> {
    return new SessionBoundCollection<T>(this.db.collection<T>(name), this.session);
  }
}

export async function withOutbox<T>(
  mongo: MongoClient,
  dbName: string,
  fn: (uow: UnitOfWork) => Promise<{ result: T; events: DomainEvent[] }>,
): Promise<T> {
  const session = mongo.startSession();
  try {
    // MongoDB retries transient transaction errors (write conflicts, primary
    // step-down) automatically. The callback MUST therefore be idempotent.
    return await session.withTransaction(async () => {
      const db = mongo.db(dbName);
      const uow = new UnitOfWork(db, session);
      const { result, events } = await fn(uow);

      // Events are appended INSIDE the transaction. If the business write rolls
      // back, so do the events — there is no window where one exists without
      // the other.
      if (events.length > 0) {
        const rows: OutboxRow[] = events.map((e) => ({
          messageId: e.messageId,
          aggregateType: e.aggregateType,
          aggregateId: e.aggregateId,
          eventType: e.type,
          eventVersion: e.version,
          routingKey: `${e.type}.v${e.version}`,
          payload: e.payload,
          headers: {
            tenantId: e.tenantId,
            correlationId: RequestContext.current()?.correlationId,
          },
          status: 'PENDING',
          attempts: 0,
          availableAt: new Date(),
          occurredAt: e.occurredAt,
        }));
        await uow.collection<OutboxRow>('outbox').insertMany(rows);
      }
      return result;
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
  } finally {
    await session.endSession();
  }
}
