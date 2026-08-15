export class SkuNotFoundError extends Error {
  constructor(skuCode: string) {
    super(`No price found for SKU ${skuCode} in the active price book`);
    this.name = 'SkuNotFoundError';
  }
}

export class NoActivePriceBookError extends Error {
  constructor(tenantId: string) {
    super(`No ACTIVE price book for tenant ${tenantId}`);
    this.name = 'NoActivePriceBookError';
  }
}

export class QuoteExpiredError extends Error {
  constructor(quoteId: string) {
    super(`Quote ${quoteId} has expired`);
    this.name = 'QuoteExpiredError';
  }
}

export class QuoteIntegrityMismatchError extends Error {
  constructor(quoteId: string) {
    super(`Quote ${quoteId} integrity hash does not match — prices may have changed`);
    this.name = 'QuoteIntegrityMismatchError';
  }
}
