import type { Db } from 'mongodb';

export async function ensureOrderIndexes(db: Db): Promise<void> {
  await db.collection('orders').createIndex({ tenantId: 1, status: 1, createdAt: -1 });

  const searchView = db.collection('order_search_view');
  await searchView.createIndex({ tenantId: 1, nameTokens: 1 });
  await searchView.createIndex({ tenantId: 1, createdAt: -1 });
}
