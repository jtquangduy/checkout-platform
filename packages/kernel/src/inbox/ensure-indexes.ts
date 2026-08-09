import type { Db } from 'mongodb';

export async function ensureInboxIndexes(db: Db): Promise<void> {
  const col = db.collection('processed_messages');
  await col.createIndex({ consumerGroup: 1, messageId: 1 }, { unique: true });
  // 30 days: long enough that a message dead-lettered during an incident and
  // replayed a week later is still recognised as a duplicate.
  await col.createIndex({ processedAt: 1 }, { expireAfterSeconds: 2_592_000 });
}
