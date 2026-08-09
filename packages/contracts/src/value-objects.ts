import { z } from 'zod';

export const Currency = z.enum(['USD', 'GBP', 'EUR', 'AUD', 'VND']);
export type Currency = z.infer<typeof Currency>;

/** Integer minor units + currency. The ONLY representation of money in the system. */
export const Money = z.object({
  amount: z.number().int(),   // 1999 === $19.99; negative allowed for credits
  currency: Currency,
}).brand<'Money'>();
export type Money = z.infer<typeof Money>;

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return Money.parse({ amount: a.amount + b.amount, currency: a.currency });
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return Money.parse({ amount: a.amount - b.amount, currency: a.currency });
}

/** Applies a decimal rate (e.g. 0.2 for 20% tax) using banker's rounding (round-half-to-even). */
export function applyRate(money: Money, rate: number): Money {
  return Money.parse({ amount: roundHalfToEven(money.amount * rate), currency: money.currency });
}

function roundHalfToEven(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Client-visible identifiers are prefixed ULIDs: sortable, opaque, self-describing in logs. */
export const OrderId    = z.string().regex(/^ord_[0-9A-HJKMNP-TV-Z]{26}$/).brand<'OrderId'>();
export const TenantId   = z.string().regex(/^ten_[0-9A-HJKMNP-TV-Z]{26}$/).brand<'TenantId'>();
export const CheckoutId = z.string().regex(/^cko_[0-9A-HJKMNP-TV-Z]{26}$/).brand<'CheckoutId'>();
export const PaymentId  = z.string().regex(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/).brand<'PaymentId'>();
export const InvoiceId  = z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/).brand<'InvoiceId'>();
export const UserId = z.string().regex(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/).brand<'UserId'>();

export type OrderId    = z.infer<typeof OrderId>;
export type TenantId   = z.infer<typeof TenantId>;
export type CheckoutId = z.infer<typeof CheckoutId>;
export type PaymentId  = z.infer<typeof PaymentId>;
export type InvoiceId  = z.infer<typeof InvoiceId>;
export type UserId = z.infer<typeof UserId>;

export const AuditFields = z.object({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  createdBy: z.string(),
  correlationId: z.string(),
});
export type AuditFields = z.infer<typeof AuditFields>;
