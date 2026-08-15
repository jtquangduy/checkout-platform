import { createHash } from 'node:crypto';
import { addMoney, applyRate, Money, multiplyMoney } from '@platform/contracts';
import { SkuNotFoundError } from '../errors.js';
import type { PriceBook } from './price-book.js';

export interface QuoteLineItemInput {
  skuCode: string;
  quantity: number;
}

export interface QuoteLine {
  skuCode: string;
  description: string;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
  taxCode: string | null;
  taxRate: number;
  taxAmount: Money;
}

export interface PricingResult {
  lines: QuoteLine[];
  subtotal: Money;
  tax: Money;
  total: Money;
  integrityHash: string;
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The ONLY place rounding happens. Called once per quote; the result is
 *  frozen into the snapshot by the caller and never recomputed (DATA-INTEGRITY
 *  §8). Pure function — no I/O, no Mongo, so it's trivial to unit test. */
export function priceOrder(priceBook: PriceBook, items: QuoteLineItemInput[]): PricingResult {
  const currency = priceBook.currency;
  const zero = Money.parse({ amount: 0, currency });

  const itemLines: QuoteLine[] = items.map((item) => {
    const priced = priceBook.prices.find((p) => p.skuCode === item.skuCode);
    if (!priced) throw new SkuNotFoundError(item.skuCode);

    const lineTotal = multiplyMoney(priced.unitPrice, item.quantity);
    return {
      skuCode: item.skuCode,
      description: priced.description,
      quantity: item.quantity,
      unitPrice: priced.unitPrice,
      lineTotal,
      taxCode: priceBook.taxProfile.code,
      taxRate: priceBook.taxProfile.rate,
      taxAmount: applyRate(lineTotal, priceBook.taxProfile.rate),
    };
  });

  const subtotal = itemLines.reduce((sum, line) => addMoney(sum, line.lineTotal), zero);

  // The tier is selected on total units across ALL lines and applied to the
  // WHOLE subtotal, per DATA-MODEL.md's worked example — modelling it per
  // line gives a different (wrong) total than the commercial agreement
  // specifies. Simplification: this sums every item's quantity, not just
  // "retouching units" as the docs' prose distinguishes — there's no SKU
  // category field to tell the two apart, and Phase 1 is single-SKU anyway.
  const totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);
  const tier = [...priceBook.orderVolumeTiers]
    .sort((a, b) => b.minUnits - a.minUnits)
    .find((t) => totalUnits >= t.minUnits);

  const discountLine: QuoteLine | null = tier
    ? (() => {
        const amount = applyRate(subtotal, -(tier.discountBps / 10_000));
        return {
          skuCode: 'VOLUME_DISCOUNT',
          description: `Volume discount (${tier.discountBps} bps)`,
          quantity: 1,
          unitPrice: amount,
          lineTotal: amount,
          taxCode: null,
          taxRate: 0,
          taxAmount: zero,
        };
      })()
    : null;

  const lines = discountLine ? [...itemLines, discountLine] : itemLines;
  const tax = lines.reduce((sum, line) => addMoney(sum, line.taxAmount), zero);
  const total = addMoney(lines.reduce((sum, line) => addMoney(sum, line.lineTotal), zero), tax);

  const integrityHash = `sha256:${createHash('sha256')
    .update(canonicalStringify({ lines, subtotal, tax, total, priceBookVersion: priceBook.version }))
    .digest('hex')}`;

  return { lines, subtotal, tax, total, integrityHash };
}
