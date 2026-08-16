import { QuoteId, TenantId } from '@platform/contracts';
import { Quote } from '../../domain/quote/quote.js';
import type { QuoteDocument } from './quote.document.js';

export function toQuoteDocument(quote: Quote): QuoteDocument {
  const s = quote.snapshot;
  return {
    _id: s.id,
    tenantId: s.tenantId,
    orderId: s.orderId,
    priceBookId: s.priceBookId,
    priceBookVersion: s.priceBookVersion,
    lines: s.lines,
    subtotal: s.subtotal,
    tax: s.tax,
    total: s.total,
    integrityHash: s.integrityHash,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
  };
}

export function toQuoteDomain(doc: QuoteDocument): Quote {
  return Quote.reconstitute({
    id: QuoteId.parse(doc._id),
    tenantId: TenantId.parse(doc.tenantId),
    orderId: doc.orderId,
    priceBookId: doc.priceBookId,
    priceBookVersion: doc.priceBookVersion,
    lines: doc.lines,
    subtotal: doc.subtotal,
    tax: doc.tax,
    total: doc.total,
    integrityHash: doc.integrityHash,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  });
}
