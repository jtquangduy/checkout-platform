import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantId } from '@platform/contracts';

export interface RequestContextData {
  tenantId: TenantId;
  userId: string;
  roles: string[];
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContextData>();

export class MissingTenantContextError extends Error {
  constructor() {
    super('No tenant context is active — this code path must run inside RequestContext.run()');
    this.name = 'MissingTenantContextError';
  }
}

export const RequestContext = {
  run<R>(data: RequestContextData, fn: () => R): R {
    return storage.run(data, fn);
  },
  current(): RequestContextData | undefined {
    return storage.getStore();
  },
  tenantId(): TenantId {
    const ctx = storage.getStore();
    if (!ctx) throw new MissingTenantContextError();
    return ctx.tenantId;
  },
  userId(): string {
    const ctx = storage.getStore();
    if (!ctx) throw new MissingTenantContextError();
    return ctx.userId;
  },
  roles(): string[] {
    return storage.getStore()?.roles ?? [];
  },
  correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },
};
