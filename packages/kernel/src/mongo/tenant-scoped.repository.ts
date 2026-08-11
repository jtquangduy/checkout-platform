import type { Collection, Filter, OptionalUnlessRequiredId, UpdateFilter } from 'mongodb';
import { RequestContext } from '../context/request-context.js';

export interface TenantScoped {
  tenantId: string;
}

export abstract class TenantScopedRepository<T extends TenantScoped> {
  protected constructor(protected readonly col: Collection<T>) {}

  /** The ONLY way to build a filter. tenantId is not a parameter, so it
   *  cannot be forgotten, and it comes from the verified token via
   *  RequestContext, so a caller can never spoof it — our value is spread
   *  last, so it always wins over anything in the caller's own filter. */
  private scoped(filter: Filter<T> = {}): Filter<T> {
    const tenantId = RequestContext.tenantId();
    return { ...filter, tenantId } as Filter<T>;
  }

  findOne(filter: Filter<T> = {}) {
    return this.col.findOne(this.scoped(filter));
  }

  find(filter: Filter<T> = {}) {
    return this.col.find(this.scoped(filter));
  }

  insertOne(doc: OptionalUnlessRequiredId<T>) {
    return this.col.insertOne(doc);
  }

  updateOne(filter: Filter<T>, update: UpdateFilter<T>) {
    return this.col.updateOne(this.scoped(filter), update);
  }
}
