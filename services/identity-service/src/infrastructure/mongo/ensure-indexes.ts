import type { Db } from 'mongodb';

export async function ensureUserIndexes(db: Db): Promise<void> {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ tenantId: 1, status: 1 });
}
