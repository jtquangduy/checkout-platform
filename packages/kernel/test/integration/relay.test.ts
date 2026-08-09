import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import amqplib, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { ensureOutboxIndexes } from '../../src/outbox/ensure-indexes.js';
import { connectRabbit, EXCHANGE, type RabbitConnection } from '../../src/outbox/rabbit-connection.js';
import { claimBatch } from '../../src/outbox/claim-batch.js';
import { relayTick } from '../../src/outbox/relay.js';
import type { OutboxRow } from '../../src/outbox/types.js';

const MONGO_URI =
  process.env.MONGO_TEST_URI ??
  'mongodb://admin:devpassword@localhost:27017/?replicaSet=rs0&directConnection=true&authSource=admin';
const RABBIT_URL = process.env.RABBITMQ_TEST_URL ?? 'amqp://guest:guest@localhost:5672';
const DB_NAME = 'kernel_relay_test';

let mongoClient: MongoClient;
let db: Db;
let rabbit: RabbitConnection;
let testConn: ChannelModel;
let testChannel: ConfirmChannel;
let testQueue: string;

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    messageId: `evt_${Math.random().toString(36).slice(2)}`,
    aggregateType: 'TestAggregate',
    aggregateId: 'agg_1',
    eventType: 'test.happened',
    eventVersion: 1,
    routingKey: 'test.happened.v1',
    payload: { ok: true },
    headers: { tenantId: 'ten_test', correlationId: undefined },
    status: 'PENDING',
    attempts: 0,
    availableAt: new Date(),
    occurredAt: new Date(),
    ...overrides,
  };
}

beforeAll(async () => {
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  await ensureOutboxIndexes(db);

  rabbit = await connectRabbit(RABBIT_URL);

  testConn = await amqplib.connect(RABBIT_URL);
  testChannel = await testConn.createConfirmChannel();
  const q = await testChannel.assertQueue('', { exclusive: true });
  testQueue = q.queue;
  await testChannel.bindQueue(testQueue, EXCHANGE, '#');
});

afterEach(async () => {
  await db.collection('outbox').deleteMany({});
});

afterAll(async () => {
  await testChannel.close();
  await testConn.close();
  await rabbit.close();
  await db.dropDatabase();
  await mongoClient.close();
});

function consumeOne(timeoutMs = 3000): Promise<{ routingKey: string; content: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    testChannel.consume(
      testQueue,
      (msg) => {
        if (!msg) return;
        clearTimeout(timer);
        testChannel.ack(msg);
        resolve({ routingKey: msg.fields.routingKey, content: JSON.parse(msg.content.toString()) });
      },
      { noAck: false },
    );
  });
}

describe('outbox relay', () => {
  it('publishes a claimed row and marks it PUBLISHED', async () => {
    const outbox = db.collection<OutboxRow>('outbox');
    const row = makeRow();
    await outbox.insertOne(row);

    const received = consumeOne();
    await relayTick(outbox, rabbit.channel, { workerId: 'test-worker' });

    const msg = await received;
    expect(msg.routingKey).toBe(row.routingKey);
    expect(msg.content).toEqual(row.payload);

    const updated = await outbox.findOne({ messageId: row.messageId });
    expect(updated?.status).toBe('PUBLISHED');
  });

  it('never lets two workers claim the same row', async () => {
    const outbox = db.collection<OutboxRow>('outbox');
    await outbox.insertOne(makeRow());

    const [batchA, batchB] = await Promise.all([
      claimBatch(outbox, { limit: 10, claimedBy: 'worker-a', leaseForMs: 30_000 }),
      claimBatch(outbox, { limit: 10, claimedBy: 'worker-b', leaseForMs: 30_000 }),
    ]);

    expect(batchA.length + batchB.length).toBe(1); // exactly one winner, never both, never neither
  });

  it('reclaims a row whose lease has expired (simulating a crashed worker)', async () => {
    const outbox = db.collection<OutboxRow>('outbox');
    const row = makeRow();
    await outbox.insertOne(row);
    await outbox.updateOne(
      { messageId: row.messageId },
      { $set: { claimedBy: 'dead-worker', leaseExpiresAt: new Date(Date.now() - 1000) } },
    );

    const reclaimed = await claimBatch(outbox, { limit: 10, claimedBy: 'live-worker', leaseForMs: 30_000 });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.claimedBy).toBe('live-worker');
  });

  it('backs off instead of retrying immediately after a publish failure', async () => {
    const outbox = db.collection<OutboxRow>('outbox');
    const row = makeRow();
    await outbox.insertOne(row);

    const brokenChannel = {
      publish: () => { throw new Error('simulated broker outage'); },
    } as unknown as ConfirmChannel;
    await relayTick(outbox, brokenChannel, { workerId: 'test-worker' });

    const updated = await outbox.findOne({ messageId: row.messageId });
    expect(updated?.status).toBe('PENDING');
    expect(updated?.attempts).toBe(1);
    expect(updated?.availableAt.getTime()).toBeGreaterThan(Date.now());
  });
});
