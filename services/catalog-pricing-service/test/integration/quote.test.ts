import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { newId, TenantId } from '@platform/contracts';
import { CreateQuoteUseCase } from '../../src/application/create-quote.usecase.js';
import { VerifyQuoteUseCase } from '../../src/application/verify-quote.usecase.js';
import { ensureCatalogPricingIndexes } from '../../src/infrastructure/mongo/ensure-indexes.js';
import { NoActivePriceBookError } from '../../src/domain/errors.js';
import type { PriceBookDocument } from '../../src/infrastructure/mongo/price-book.document.js';
import type { QuoteDocument } from '../../src/infrastructure/mongo/quote.document.js';

const MONGO_URI =
  process.env.MONGO_TEST_URI ??
  'mongodb://admin:devpassword@localhost:27017/?replicaSet=rs0&directConnection=true&authSource=admin';
const DB_NAME = 'catalog_pricing_test';

let client: MongoClient;
let db: Db;
let createQuote: CreateQuoteUseCase;
let verifyQuote: VerifyQuoteUseCase;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await ensureCatalogPricingIndexes(db);

  createQuote = new CreateQuoteUseCase(client, DB_NAME);
  verifyQuote = new VerifyQuoteUseCase(client, DB_NAME);
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

async function seedActivePriceBook(tenantId: string): Promise<void> {
  const now = new Date();
  const doc: PriceBookDocument = {
    _id: newId('pbk'),
    tenantId,
    name: 'Test Book',
    version: 1,
    currency: 'GBP',
    status: 'ACTIVE',
    effectiveFrom: now,
    effectiveTo: null,
    prices: [
      { skuCode: 'GHOST_MANNEQUIN_V2', description: 'Ghost mannequin (v2)', unitPrice: { amount: 320, currency: 'GBP' } as never },
    ],
    orderVolumeTiers: [
      { minUnits: 200, discountBps: 250 },
      { minUnits: 400, discountBps: 500 },
    ],
    taxProfile: { code: 'GB-VAT-STD', rate: 0.2, reverseCharge: false },
    createdAt: now,
    updatedAt: now,
  };
  await db.collection<PriceBookDocument>('price_books').insertOne(doc);
}

describe('CreateQuoteUseCase + VerifyQuoteUseCase', () => {
  it("creates a quote from the tenant's active price book and persists it", async () => {
    const tenantId = TenantId.parse(newId('ten'));
    await seedActivePriceBook(tenantId);

    const quote = await createQuote.execute({
      tenantId,
      orderId: newId('ord'),
      items: [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 100 }],
    });

    expect(quote.snapshot.total).toEqual({ amount: 38_400, currency: 'GBP' });

    const doc = await db.collection<QuoteDocument>('quotes').findOne({ _id: quote.id });
    expect(doc?.integrityHash).toBe(quote.snapshot.integrityHash);
  });

  it('throws NoActivePriceBookError when the tenant has no active price book', async () => {
    const tenantId = TenantId.parse(newId('ten'));

    await expect(
      createQuote.execute({ tenantId, orderId: newId('ord'), items: [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 1 }] }),
    ).rejects.toThrow(NoActivePriceBookError);
  });

  it('verifies a freshly created quote as OK', async () => {
    const tenantId = TenantId.parse(newId('ten'));
    await seedActivePriceBook(tenantId);

    const quote = await createQuote.execute({
      tenantId,
      orderId: newId('ord'),
      items: [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 100 }],
    });

    const result = await verifyQuote.execute({
      tenantId,
      quoteId: quote.id,
      expectedIntegrityHash: quote.snapshot.integrityHash,
    });

    expect(result).toEqual({ outcome: 'OK', total: { amount: 38_400, currency: 'GBP' } });
  });

  it('returns MISMATCH when the expected hash does not match the stored quote', async () => {
    const tenantId = TenantId.parse(newId('ten'));
    await seedActivePriceBook(tenantId);

    const quote = await createQuote.execute({
      tenantId,
      orderId: newId('ord'),
      items: [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 100 }],
    });

    const result = await verifyQuote.execute({
      tenantId,
      quoteId: quote.id,
      expectedIntegrityHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000',
    });

    expect(result).toEqual({ outcome: 'MISMATCH' });
  });

  it('returns NOT_FOUND for an unknown quote id', async () => {
    const tenantId = TenantId.parse(newId('ten'));

    const result = await verifyQuote.execute({
      tenantId,
      quoteId: newId('quo'),
      expectedIntegrityHash: 'sha256:whatever',
    });

    expect(result).toEqual({ outcome: 'NOT_FOUND' });
  });

  it('returns EXPIRED for a quote whose expiresAt has already passed', async () => {
    const tenantId = TenantId.parse(newId('ten'));
    await seedActivePriceBook(tenantId);

    const quote = await createQuote.execute({
      tenantId,
      orderId: newId('ord'),
      items: [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 100 }],
    });

    // Backdate expiresAt directly - simulates an old quote without waiting
    // 7 real days for Mongo's TTL sweep.
    await db.collection<QuoteDocument>('quotes').updateOne(
      { _id: quote.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const result = await verifyQuote.execute({
      tenantId,
      quoteId: quote.id,
      expectedIntegrityHash: quote.snapshot.integrityHash,
    });

    expect(result).toEqual({ outcome: 'EXPIRED' });
  });
});
