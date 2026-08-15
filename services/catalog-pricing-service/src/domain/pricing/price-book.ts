import type { Currency, Money } from '@platform/contracts';

export interface PriceBookEntry {
  skuCode: string;
  description: string;
  unitPrice: Money;
}

export interface VolumeTier {
  minUnits: number;
  discountBps: number;
}

export interface TaxProfile {
  code: string;
  rate: number;
  reverseCharge: boolean;
}

/** Plain data, not a class — a price book has no lifecycle transitions of its
 *  own in this build; it's the PricingEngine's input, edited by seeding a new
 *  version rather than mutating one in place. */
export interface PriceBook {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  currency: Currency;
  status: 'ACTIVE' | 'DRAFT' | 'RETIRED';
  effectiveFrom: Date;
  effectiveTo: Date | null;
  prices: PriceBookEntry[];
  orderVolumeTiers: VolumeTier[];
  taxProfile: TaxProfile;
}
