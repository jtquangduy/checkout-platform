import type { MongoClient } from 'mongodb';
import type { Money, TenantId } from '@platform/contracts';
import { toQuoteDomain } from '../infrastructure/mongo/quote.mapper.js';
import type { QuoteDocument } from '../infrastructure/mongo/quote.document.js';

export interface VerifyQuoteCommand {
  tenantId: TenantId;
  quoteId: string;
  expectedIntegrityHash: string;
}

export type VerifyQuoteResult =
  | { outcome: 'OK'; total: Money }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'EXPIRED' }
  | { outcome: 'MISMATCH' };

export class VerifyQuoteUseCase {
  constructor(
    private readonly mongo: MongoClient,
    private readonly dbName: string,
  ) {}

  // Read-only, no transaction: re-hashes the STORED snapshot rather than
  // recomputing pricing, so it's O(lines), not O(units) - this is what the
  // orchestrator's VERIFY_QUOTE saga step needs to stay cheap.
  async execute(cmd: VerifyQuoteCommand): Promise<VerifyQuoteResult> {
    const db = this.mongo.db(this.dbName);
    const doc = await db.collection<QuoteDocument>('quotes').findOne({ _id: cmd.quoteId, tenantId: cmd.tenantId });
    if (!doc) return { outcome: 'NOT_FOUND' };

    const quote = toQuoteDomain(doc);
    if (quote.isExpired()) return { outcome: 'EXPIRED' };
    if (!quote.matchesHash(cmd.expectedIntegrityHash)) return { outcome: 'MISMATCH' };

    return { outcome: 'OK', total: quote.snapshot.total };
  }
}
