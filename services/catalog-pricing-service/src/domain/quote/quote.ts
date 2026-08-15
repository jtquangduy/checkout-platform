import { newId, QuoteId, type Money, type TenantId } from '@platform/contracts';
import type { QuoteLine } from '../pricing/pricing-engine.js';

const QUOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — DATA-MODEL.md §9

export interface QuoteProps {
  id: QuoteId;
  tenantId: TenantId;
  orderId: string;
  priceBookId: string;
  priceBookVersion: number;
  lines: QuoteLine[];
  subtotal: Money;
  tax: Money;
  total: Money;
  integrityHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export class Quote {
  private constructor(private readonly props: QuoteProps) {}

  static create(input: {
    tenantId: TenantId;
    orderId: string;
    priceBookId: string;
    priceBookVersion: number;
    lines: QuoteLine[];
    subtotal: Money;
    tax: Money;
    total: Money;
    integrityHash: string;
  }): Quote {
    const now = new Date();
    return new Quote({
      ...input,
      id: QuoteId.parse(newId('quo')),
      expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
      createdAt: now,
    });
  }

  static reconstitute(props: QuoteProps): Quote {
    return new Quote(props);
  }

  get id(): QuoteId { return this.props.id; }
  get tenantId(): TenantId { return this.props.tenantId; }
  get snapshot(): Readonly<QuoteProps> { return { ...this.props }; }

  /** Mongo's TTL deletion runs on a background sweep, not instantaneously, so
   *  a caller must still check this explicitly rather than trust the document
   *  merely still existing. */
  isExpired(now: Date = new Date()): boolean {
    return now.getTime() >= this.props.expiresAt.getTime();
  }

  matchesHash(hash: string): boolean {
    return this.props.integrityHash === hash;
  }
}
