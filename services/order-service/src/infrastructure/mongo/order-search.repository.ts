import type { Collection } from 'mongodb';
import { TenantScopedRepository } from '@platform/kernel';
import type { OrderSearchViewDocument } from './order-search-view.document.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class OrderSearchRepository extends TenantScopedRepository<OrderSearchViewDocument> {
  constructor(col: Collection<OrderSearchViewDocument>) {
    super(col);
  }

  /** Prefix match against any token — a placeholder for the Atlas Search
   *  cutover PERFORMANCE.md describes; correct, not yet fast at scale. */
  async search(queryText: string): Promise<OrderSearchViewDocument[]> {
    const token = queryText.trim().toLowerCase();
    if (!token) return this.find().toArray();
    return this.find({ nameTokens: { $regex: `^${escapeRegex(token)}` } }).toArray();
  }
}
