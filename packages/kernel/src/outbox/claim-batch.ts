import type { Collection, WithId } from 'mongodb';
import type { OutboxRow } from './types.js';

export interface ClaimBatchOptions {
  limit: number;
  claimedBy: string;
  leaseForMs: number;
}

/** One atomic findOneAndUpdate per row, looped — there is no separate lock to
 *  leak or forget to release. A worker crash simply lets the lease expire. */
export async function claimBatch(
  outbox: Collection<OutboxRow>,
  { limit, claimedBy, leaseForMs }: ClaimBatchOptions,
): Promise<WithId<OutboxRow>[]> {
  const now = new Date();
  const claimed: WithId<OutboxRow>[] = [];

  for (let i = 0; i < limit; i++) {
    const row = await outbox.findOneAndUpdate(
      {
        status: 'PENDING',
        availableAt: { $lte: now },
        $or: [{ leaseExpiresAt: { $exists: false } }, { leaseExpiresAt: { $lte: now } }],
      },
      { $set: { claimedBy, leaseExpiresAt: new Date(now.getTime() + leaseForMs) } },
      { sort: { occurredAt: 1 }, returnDocument: 'after' },
    );
    if (!row) break;
    claimed.push(row);
  }
  return claimed;
}
