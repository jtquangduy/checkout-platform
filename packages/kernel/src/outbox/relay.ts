import type { Collection } from 'mongodb';
import type { ConfirmChannel } from 'amqplib';
import { claimBatch } from './claim-batch.js';
import { backoffMs } from './backoff.js';
import { EXCHANGE } from './rabbit-connection.js';
import type { OutboxRow } from './types.js';

export interface OutboxRelayOptions {
  workerId: string;
  batchSize?: number;
  leaseForMs?: number;
  pollIntervalMs?: number;
}

export async function relayTick(
  outbox: Collection<OutboxRow>,
  channel: ConfirmChannel,
  opts: Pick<OutboxRelayOptions, 'workerId' | 'batchSize' | 'leaseForMs'>,
): Promise<{ published: number; failed: number }> {
  const batch = await claimBatch(outbox, {
    limit: opts.batchSize ?? 100,
    claimedBy: opts.workerId,
    leaseForMs: opts.leaseForMs ?? 30_000,
  });

  let published = 0;
  let failed = 0;

  for (const row of batch) {
    try {
      channel.publish(EXCHANGE, row.routingKey, Buffer.from(JSON.stringify(row.payload)), {
        messageId: row.messageId,
        persistent: true,
        headers: row.headers,
        contentType: 'application/json',
        timestamp: row.occurredAt.getTime(),
      });
      // Only mark PUBLISHED once the broker has actually confirmed receipt —
      // publish() alone just means "handed to a local buffer".
      await channel.waitForConfirms();
      await outbox.updateOne({ _id: row._id }, { $set: { status: 'PUBLISHED', publishedAt: new Date() } });
      published++;
    } catch (err) {
      // Release the lease immediately so backoff, not the lease duration,
      // governs when this row becomes retryable again.
      await outbox.updateOne(
        { _id: row._id },
        {
          $set: {
            availableAt: new Date(Date.now() + backoffMs(row.attempts)),
            lastError: err instanceof Error ? err.message : String(err),
          },
          $inc: { attempts: 1 },
          $unset: { leaseExpiresAt: '' },
        },
      );
      failed++;
    }
  }
  return { published, failed };
}

export function startOutboxRelay(
  outbox: Collection<OutboxRow>,
  channel: ConfirmChannel,
  opts: OutboxRelayOptions,
): { stop: () => void } {
  let stopped = false;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;

  void (async () => {
    while (!stopped) {
      await relayTick(outbox, channel, opts);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  })();

  return { stop: () => { stopped = true; } };
}
