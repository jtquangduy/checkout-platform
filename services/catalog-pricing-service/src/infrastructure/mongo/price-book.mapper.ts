import type { PriceBook } from '../../domain/pricing/price-book.js';
import type { PriceBookDocument } from './price-book.document.js';

// No reverse mapper yet - price books are seeded directly as documents in
// this pass, not created through the domain layer (no admin CRUD API; see
// Step 11's research notes).
export function toPriceBookDomain(doc: PriceBookDocument): PriceBook {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    name: doc.name,
    version: doc.version,
    currency: doc.currency,
    status: doc.status,
    effectiveFrom: doc.effectiveFrom,
    effectiveTo: doc.effectiveTo,
    prices: doc.prices,
    orderVolumeTiers: doc.orderVolumeTiers,
    taxProfile: doc.taxProfile,
  };
}
