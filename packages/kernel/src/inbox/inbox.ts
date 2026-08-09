import type { ClientSession, Collection } from 'mongodb';
import { ConcurrentDeliveryError } from './errors.js';
import { isDuplicateKeyError } from './is-duplicate-key-error.js';
import { isLeaseExpired } from './is-lease-expired.js';
import type { InboxRecord } from './types.js';

export interface InboxOptions {
  claimedBy: string;
  leaseMs?: number;
}

export class Inbox {
  private readonly leaseMs: number;

  constructor(
    private readonly col: Collection<InboxRecord>,
    private readonly group: string,
    private readonly opts: InboxOptions,
  ) {
    this.leaseMs = opts.leaseMs ?? 60_000;
  }

  /** Returns the previous record if this message was already handled, else
   *  null and the claim is ours. Concurrency-safe with NO distributed lock —
   *  the unique index on {consumerGroup, messageId} makes the insert itself
   *  the check. */
  async claim(messageId: string): Promise<InboxRecord | null> {
    try {
      await this.col.insertOne({
        consumerGroup: this.group,
        messageId,
        state: 'IN_PROGRESS',
        claimedAt: new Date(),
        claimedBy: this.opts.claimedBy,
        leaseExpiresAt: new Date(Date.now() + this.leaseMs),
      });
      return null; // first delivery — proceed
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;

      const existing = await this.col.findOne({ consumerGroup: this.group, messageId });
      if (existing?.state === 'SUCCEEDED') return existing; // ack; do not redo the work

      if (existing?.state === 'IN_PROGRESS' && isLeaseExpired(existing)) {
        const reclaimed = await this.col.findOneAndUpdate(
          { consumerGroup: this.group, messageId, claimedBy: existing.claimedBy },
          {
            $set: {
              claimedBy: this.opts.claimedBy,
              claimedAt: new Date(),
              leaseExpiresAt: new Date(Date.now() + this.leaseMs),
            },
          },
        );
        if (reclaimed) return null; // we now own it
      }

      throw new ConcurrentDeliveryError(messageId); // nack → retry ladder
    }
  }

  /** Completes the inbox record in the SAME transaction as the business
   *  write, so "work done" and "work recorded" cannot diverge. */
  async complete(session: ClientSession, messageId: string, result: { resultRef: string }): Promise<void> {
    await this.col.updateOne(
      { consumerGroup: this.group, messageId },
      { $set: { state: 'SUCCEEDED', resultRef: result.resultRef, processedAt: new Date() } },
      { session },
    );
  }
}
