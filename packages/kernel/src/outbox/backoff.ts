/** Exponential backoff with jitter, capped at 60s. Governs retry spacing after
 *  a publish failure — separate from the consumer-side retry ladder in EVENTS.md,
 *  which is about redelivery of an already-published message, not this. */
export function backoffMs(attempts: number): number {
  const capMs = 60_000;
  const base = Math.min(1_000 * 2 ** attempts, capMs);
  return base + Math.random() * base * 0.2;
}
