import type { Db } from 'mongodb';

export async function ensureCatalogPricingIndexes(db: Db): Promise<void> {
  await db.collection('price_books').createIndex({ tenantId: 1, status: 1, effectiveFrom: -1 });
  await db.collection('quotes').createIndex({ tenantId: 1, orderId: 1, createdAt: -1 });
  await db.collection('quotes').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL delete
}
