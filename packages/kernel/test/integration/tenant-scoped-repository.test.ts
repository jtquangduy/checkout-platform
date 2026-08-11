import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Collection, type Db } from 'mongodb';
import { newId, TenantId } from '@platform/contracts';
import { RequestContext } from '../../src/context/request-context.js';
import { MissingTenantContextError } from '../../src/context/request-context.js';
import { TenantScopedRepository, type TenantScoped } from '../../src/mongo/tenant-scoped.repository.js';

interface Widget extends TenantScoped {
  _id: string;
  tenantId: string;
  name: string;
}

class WidgetRepository extends TenantScopedRepository<Widget> {
  constructor(col: Collection<Widget>) {
    super(col);
  }
}

const MONGO_URI =
  process.env.MONGO_TEST_URI ??
  'mongodb://admin:devpassword@localhost:27017/?replicaSet=rs0&directConnection=true&authSource=admin';
const DB_NAME = 'kernel_tenant_scoped_test';

let client: MongoClient;
let db: Db;
let repo: WidgetRepository;

// Real ids — the TenantId brand requires a valid ULID body, so a hand-typed
// placeholder like 'ten_a' fails Zod's regex before the test even runs.
const tenantA = TenantId.parse(newId('ten'));
const tenantB = TenantId.parse(newId('ten'));

function ctx(tenantId: TenantId) {
  return { tenantId, userId: 'u1', roles: [], correlationId: 'c1' };
}

beforeAll(async () => {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  repo = new WidgetRepository(db.collection<Widget>('widgets'));
});

afterEach(async () => {
  await db.collection('widgets').deleteMany({});
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

describe('TenantScopedRepository', () => {
  it('throws outside of a tenant context, synchronously', () => {
    expect(() => repo.findOne()).toThrow(MissingTenantContextError);
  });

  it('a tenant can never see another tenant\'s document, even by exact _id', async () => {
    await RequestContext.run(ctx(tenantA), async () => {
      await repo.insertOne({ _id: 'w1', tenantId: tenantA, name: 'from A' });
    });

    const seenByB = await RequestContext.run(ctx(tenantB), () => repo.findOne({ _id: 'w1' }));
    expect(seenByB).toBeNull();

    const seenByA = await RequestContext.run(ctx(tenantA), () => repo.findOne({ _id: 'w1' }));
    expect(seenByA?.name).toBe('from A');
  });

  it('a caller-supplied tenantId in the filter can never override the real one', async () => {
    await RequestContext.run(ctx(tenantA), async () => {
      await repo.insertOne({ _id: 'w2', tenantId: tenantA, name: 'real owner is A' });
    });

    // Inside tenant A's own context, try to smuggle a different tenantId
    // into the filter — the repository's own value must still win.
    const result = await RequestContext.run(ctx(tenantA), () =>
      repo.findOne({ _id: 'w2', tenantId: tenantB } as Partial<Widget>),
    );
    expect(result?.name).toBe('real owner is A');
  });

  it('never leaks across two concurrently-running tenant contexts', async () => {
    await RequestContext.run(ctx(tenantA), () => repo.insertOne({ _id: 'w3', tenantId: tenantA, name: 'A' }));
    await RequestContext.run(ctx(tenantB), () => repo.insertOne({ _id: 'w4', tenantId: tenantB, name: 'B' }));

    const [resultsA, resultsB] = await Promise.all([
      RequestContext.run(ctx(tenantA), async () => {
        await new Promise((r) => setTimeout(r, 20));
        return repo.find().toArray();
      }),
      RequestContext.run(ctx(tenantB), async () => {
        await new Promise((r) => setTimeout(r, 5));
        return repo.find().toArray();
      }),
    ]);

    expect(resultsA.map((w) => w.name)).toEqual(['A']);
    expect(resultsB.map((w) => w.name)).toEqual(['B']);
  });
});
