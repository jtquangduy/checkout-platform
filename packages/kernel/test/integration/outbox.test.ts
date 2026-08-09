import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { withOutbox } from '../../src/outbox/unit-of-work.js';
import { ensureOutboxIndexes } from '../../src/outbox/ensure-indexes.js';
import type { DomainEvent, OutboxRow } from '../../src/outbox/types.js';

interface Widget {
  _id: string;
  status: string;
}

interface Counter {
  _id: string;
  value: number;
}

const MONGO_URI =
  process.env.MONGO_TEST_URI ??
  'mongodb://admin:devpassword@localhost:27017/?replicaSet=rs0&directConnection=true&authSource=admin';
const DB_NAME = 'kernel_outbox_test';

let client: MongoClient;
let db: Db;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await ensureOutboxIndexes(db);
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

function fakeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    messageId: `evt_${Math.random().toString(36).slice(2)}`,
    aggregateType: 'TestAggregate',
    aggregateId: 'agg_1',
    type: 'test.happened',
    version: 1,
    tenantId: 'ten_test',
    payload: { ok: true },
    occurredAt: new Date(),
    ...overrides,
  };
}

describe('withOutbox', () => {
  it('commits the business write and the outbox row in one transaction', async () => {
    const event = fakeEvent();
    await withOutbox(client, DB_NAME, async (uow) => {
      await uow.collection<Widget>('widgets').insertOne({ _id: 'w1', status: 'DONE' });
      return { result: undefined, events: [event] };
    });

    const widget = await db.collection<Widget>('widgets').findOne({ _id: 'w1' });
    const outboxRow = await db.collection<OutboxRow>('outbox').findOne({ messageId: event.messageId });
    expect(widget?.status).toBe('DONE');
    expect(outboxRow?.status).toBe('PENDING');
    expect(outboxRow?.eventType).toBe('test.happened');
  });

  it('rolls back the business write if the callback throws after it', async () => {
    await expect(
      withOutbox(client, DB_NAME, async (uow) => {
        await uow.collection<Widget>('widgets').insertOne({ _id: 'w2', status: 'DONE' });
        throw new Error('simulated failure after the business write');
      }),
    ).rejects.toThrow('simulated failure');

    const widget = await db.collection<Widget>('widgets').findOne({ _id: 'w2' });
    expect(widget).toBeNull();
  });

  it('loses no updates and drops no events under concurrent writers', async () => {
    const N = 20;
    await db.collection<Counter>('counters').insertOne({ _id: 'c1', value: 0 });

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withOutbox(client, DB_NAME, async (uow) => {
          await uow.collection<Counter>('counters').updateOne({ _id: 'c1' }, { $inc: { value: 1 } });
          return { result: undefined, events: [fakeEvent({ messageId: `evt_concurrent_${i}` })] };
        }),
      ),
    );

    const counter = await db.collection<Counter>('counters').findOne({ _id: 'c1' });
    const outboxCount = await db
      .collection<OutboxRow>('outbox')
      .countDocuments({ messageId: { $regex: /^evt_concurrent_/ } });
    expect(counter?.value).toBe(N);   // no lost updates across concurrent transactions
    expect(outboxCount).toBe(N);      // exactly one event per successful write
  }, 20_000);

  it('rejects a duplicate messageId via the unique index', async () => {
    const event = fakeEvent();
    await withOutbox(client, DB_NAME, async (uow) => {
      await uow.collection<Widget>('widgets').insertOne({ _id: 'w3', status: 'DONE' });
      return { result: undefined, events: [event] };
    });

    await expect(
      withOutbox(client, DB_NAME, async (uow) => {
        await uow.collection<Widget>('widgets').insertOne({ _id: 'w4', status: 'DONE' });
        return { result: undefined, events: [event] }; // same messageId again
      }),
    ).rejects.toThrow();
  });
});
