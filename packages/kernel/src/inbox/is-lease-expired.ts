import type { InboxRecord } from './types.js';

/** Reads the expiry stamped onto the record at claim time, never the
 *  checking caller's own configured lease duration — otherwise two workers
 *  with different leaseMs values could disagree about whether a claim has
 *  expired. */
export function isLeaseExpired(record: InboxRecord): boolean {
  return record.leaseExpiresAt.getTime() < Date.now();
}
