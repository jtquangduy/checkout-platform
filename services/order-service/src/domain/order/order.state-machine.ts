export const ORDER_STATUSES = [
  'DRAFT', 'PRICING', 'READY_FOR_CHECKOUT', 'CHECKOUT_PENDING',
  'PAID_AWAITING_PRODUCTION', 'PRODUCTION_REJECTED', 'IN_PRODUCTION',
  'QA_REVIEW', 'DELIVERED', 'CANCELLED', 'REFUNDED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Legal transitions AS DATA — "is X -> Y allowed?" is one lookup, not a
// chain of conditionals scattered across methods.
const LEGAL: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['PRICING', 'CANCELLED'],
  PRICING: ['READY_FOR_CHECKOUT', 'DRAFT'],
  READY_FOR_CHECKOUT: ['CHECKOUT_PENDING', 'PRICING', 'DRAFT', 'CANCELLED'],
  CHECKOUT_PENDING: ['READY_FOR_CHECKOUT', 'PAID_AWAITING_PRODUCTION'],
  PAID_AWAITING_PRODUCTION: ['IN_PRODUCTION', 'PRODUCTION_REJECTED'],
  PRODUCTION_REJECTED: ['REFUNDED', 'IN_PRODUCTION'],
  IN_PRODUCTION: ['QA_REVIEW'],
  QA_REVIEW: ['DELIVERED', 'IN_PRODUCTION'],
  DELIVERED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export function isLegalTransition(from: OrderStatus, to: OrderStatus): boolean {
  return LEGAL[from].includes(to);
}
