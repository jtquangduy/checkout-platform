import type { MongoClient } from 'mongodb';
import { withOutbox } from '@platform/kernel';
import type { TenantId } from '@platform/contracts';
import { priceOrder, type QuoteLineItemInput } from '../domain/pricing/pricing-engine.js';
import { Quote } from '../domain/quote/quote.js';
import { NoActivePriceBookError } from '../domain/errors.js';
import type { PriceBookDocument } from '../infrastructure/mongo/price-book.document.js';
import type { QuoteDocument } from '../infrastructure/mongo/quote.document.js';
import { toPriceBookDomain } from '../infrastructure/mongo/price-book.mapper.js';
import { toQuoteDocument } from '../infrastructure/mongo/quote.mapper.js';

export interface CreateQuoteCommand {
  tenantId: TenantId;
  orderId: string;
  items: QuoteLineItemInput[];
}

export class CreateQuoteUseCase {
  constructor(
    private readonly mongo: MongoClient,
    private readonly dbName: string,
  ) {}

  async execute(cmd: CreateQuoteCommand): Promise<Quote> {
    return withOutbox(this.mongo, this.dbName, async (uow) => {
      const priceBooks = uow.collection<PriceBookDocument>('price_books');
      const doc = await priceBooks.findOne({ tenantId: cmd.tenantId, status: 'ACTIVE' });
      if (!doc) throw new NoActivePriceBookError(cmd.tenantId);

      const priceBook = toPriceBookDomain(doc);
      const priced = priceOrder(priceBook, cmd.items);

      const quote = Quote.create({
        tenantId: cmd.tenantId,
        orderId: cmd.orderId,
        priceBookId: priceBook.id,
        priceBookVersion: priceBook.version,
        ...priced,
      });

      await uow.collection<QuoteDocument>('quotes').insertOne(toQuoteDocument(quote));

      // No consumer for a "quote created" event yet in this phase.
      return { result: quote, events: [] };
    });
  }
}
