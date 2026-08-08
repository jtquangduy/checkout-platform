import { describe, it, expect } from 'vitest';
import { RequestContext, MissingTenantContextError } from '../src/context/request-context.js';
import type { TenantId } from '@platform/contracts';

const tenantA = 'ten_01JBQ0000000000000000000' as TenantId;
const tenantB = 'ten_01JBQ1111111111111111111' as TenantId;

describe('RequestContext', () => {
  it('throws outside of run()', () => {
    expect(() => RequestContext.tenantId()).toThrow(MissingTenantContextError);
  });

  it('exposes the tenant inside run()', () => {
    RequestContext.run({ tenantId: tenantA, userId: 'usr_1', roles: [], correlationId: 'c1' }, () => {
      expect(RequestContext.tenantId()).toBe(tenantA);
    });
  });

  it('survives an await inside the same call chain', async () => {
    await RequestContext.run({ tenantId: tenantA, userId: 'usr_1', roles: [], correlationId: 'c1' }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      expect(RequestContext.tenantId()).toBe(tenantA);
    });
  });

  it('does not leak between two concurrent call chains', async () => {
    const results: TenantId[] = [];
    await Promise.all([
      RequestContext.run({ tenantId: tenantA, userId: 'u1', roles: [], correlationId: 'c1' }, async () => {
        await new Promise((r) => setTimeout(r, 20));
        results.push(RequestContext.tenantId());
      }),
      RequestContext.run({ tenantId: tenantB, userId: 'u2', roles: [], correlationId: 'c2' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(RequestContext.tenantId());
      }),
    ]);
    expect(results.sort()).toEqual([tenantA, tenantB].sort());
  });
});
