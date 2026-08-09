import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { ensureInboxIndexes } from '../../src/inbox/ensure-indexes.js';
import { Inbox } from '../../src/inbox/inbox.js';
import { ConcurrentDeliveryError } from '../../src/inbox/errors.js';
import type { InboxRecord } from '../../src/inbox/types.js';

const MONGO_URI =
  process.env.MONGO_TEST_URI ??
  'mongodb://admin:devpassword@localhost:27017/?replicaSet=rs0&directConnection=true&authSource=admin';
const DB_NAME = 'kernel_inbox_test';

let client: MongoClient;
let db: Db;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await ensureInboxIndexes(db);
});

afterEach(async () => {
  await db.collection('processed_messages').deleteMany({});
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

function makeInbox(claimedBy: string, leaseMs?: number) {
  return new Inbox(db.collection<InboxRecord>('processed_messages'), 'invoice-service', {
    claimedBy,
    ...(leaseMs !== undefined ? { leaseMs } : {}),
  });
}

describe('Inbox', () => {
  it('lets the first delivery through and rejects a concurrent duplicate', async () => {
    const inbox = makeInbox('worker-1');
    const first = await inbox.claim('evt_1');
    expect(first).toBeNull();

    await expect(makeInbox('worker-2').claim('evt_1')).rejects.toThrow(ConcurrentDeliveryError);
  });

  it('returns the completed record instead of redoing the work', async () => {
    const inbox = makeInbox('worker-1');
    await inbox.claim('evt_2');

    const session = client.startSession();
    await session.withTransaction(async () => {
      await inbox.complete(session, 'evt_2', { resultRef: 'inv_123' });
    });
    await session.endSession();

    const redelivered = await makeInbox('worker-2').claim('evt_2');
    expect(redelivered?.state).toBe('SUCCEEDED');
    expect(redelivered?.resultRef).toBe('inv_123');
  });

  it('reclaims a message whose lease expired (a crashed consumer)', async () => {
    const inbox = makeInbox('dead-worker', 50); // 50ms lease, expires almost immediately
    await inbox.claim('evt_3');

    await new Promise((r) => setTimeout(r, 100)); // let the lease expire

    const reclaimed = await makeInbox('live-worker').claim('evt_3');
    expect(reclaimed).toBeNull(); // null means "you now own it, proceed"
  });

  it('lets exactly one concurrent claimant win, never zero and never more than one', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => makeInbox(`worker-${i}`).claim('evt_4')),
    );

    const winners = attempts.filter((a) => a.status === 'fulfilled' && a.value === null);
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(rejected).toHaveLength(9);
  });
});
