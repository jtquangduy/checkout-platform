import type { MongoClient } from 'mongodb';
import { withOutbox } from '@platform/kernel';
import { OrderId, TenantId } from '@platform/contracts';
import { PAID_STATUSES, type OrderStatus } from '../domain/order/order.state-machine.js';
import { orderStatusChangedEvent } from '../domain/order/order.events.js';
import type { OrderDocument } from '../infrastructure/mongo/order.document.js';
import type { OrderSearchViewDocument } from '../infrastructure/mongo/order-search-view.document.js';

export interface ReserveForCheckoutCommand {
  tenantId: TenantId;
  orderId: string;
  expectedVersion: number;
  checkoutSessionId: string;
  holdTtlMs: number;
}

export type ReserveForCheckoutResult =
  | { outcome: 'OK'; newVersion: number }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'ALREADY_RESERVED'; reservedBySession: string }
  | { outcome: 'ALREADY_PAID' }
  | { outcome: 'VERSION_CONFLICT'; currentVersion: number }
  | { outcome: 'INVALID_STATE'; currentStatus: OrderStatus };

export class ReserveForCheckoutUseCase {
  constructor(
    private readonly mongo: MongoClient,
    private readonly dbName: string,
  ) {}

  async execute(cmd: ReserveForCheckoutCommand): Promise<ReserveForCheckoutResult> {
    return withOutbox<ReserveForCheckoutResult>(this.mongo, this.dbName, async (uow) => {
      const orders = uow.collection<OrderDocument>('orders');

      // ONE atomic operation. MongoDB serialises concurrent findOneAndUpdate
      // calls against the same document, so exactly one caller can match this
      // filter. status lives in the FILTER, not a check performed after a
      // separate read — that's the race window this is built to close.
      const reserved = await orders.findOneAndUpdate(
        {
          _id: cmd.orderId,
          tenantId: cmd.tenantId,
          version: cmd.expectedVersion,
          status: 'READY_FOR_CHECKOUT',
        },
        {
          $set: {
            status: 'CHECKOUT_PENDING',
            checkout: {
              sessionId: cmd.checkoutSessionId,
              reservedAt: new Date(),
              expiresAt: new Date(Date.now() + cmd.holdTtlMs),
            },
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { returnDocument: 'after' },
      );

      if (!reserved) {
        // Diagnose precisely — the loser deserves an accurate reason, not a
        // generic conflict. "Someone else is checking this out" and "already
        // paid" are different user-facing messages.
        const current = await orders.findOne({ _id: cmd.orderId, tenantId: cmd.tenantId });
        if (!current) {
          return { result: { outcome: 'NOT_FOUND' as const }, events: [] };
        }
        if (current.status === 'CHECKOUT_PENDING') {
          return {
            result: { outcome: 'ALREADY_RESERVED' as const, reservedBySession: current.checkout?.sessionId ?? 'unknown' },
            events: [],
          };
        }
        if (PAID_STATUSES.includes(current.status)) {
          return { result: { outcome: 'ALREADY_PAID' as const }, events: [] };
        }
        if (current.version !== cmd.expectedVersion) {
          return { result: { outcome: 'VERSION_CONFLICT' as const, currentVersion: current.version }, events: [] };
        }
        return { result: { outcome: 'INVALID_STATE' as const, currentStatus: current.status }, events: [] };
      }

      // Same transaction as the reservation ⇒ search can never show a stale status.
      await uow.collection<OrderSearchViewDocument>('order_search_view').updateOne(
        { _id: reserved._id, tenantId: reserved.tenantId },
        { $set: { status: reserved.status } },
      );

      const event = orderStatusChangedEvent(
        OrderId.parse(reserved._id),
        TenantId.parse(reserved.tenantId),
        'READY_FOR_CHECKOUT',
        'CHECKOUT_PENDING',
      );

      return { result: { outcome: 'OK' as const, newVersion: reserved.version }, events: [event] };
    });
  }
}
