import type { Db } from 'mongodb';

export async function ensureOutboxIndexes(db: Db): Promise<void> {
  const outbox = db.collection('outbox');
  await outbox.createIndex({ messageId: 1 }, { unique: true });
  await outbox.createIndex({ status: 1, availableAt: 1 });
}
