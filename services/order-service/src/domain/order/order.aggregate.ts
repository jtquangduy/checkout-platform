import { newId, OrderId, type TenantId } from '@platform/contracts';
import type { DomainEvent } from '@platform/kernel';
import { EmptyOrderError, IllegalTransitionError, OrderNotEditableError } from '../errors.js';
import { isLegalTransition, type OrderStatus } from './order.state-machine.js';
import { normalizeOrderName } from './order-name.vo.js';
import type { OrderItem } from './order-item.entity.js';
import { orderStatusChangedEvent } from './order.events.js';

export interface OrderProps {
  id: OrderId;
  tenantId: TenantId;
  name: string;
  nameNormalized: string;
  nameTokens: string[];
  status: OrderStatus;
  items: OrderItem[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Order {
  private pendingEvents: DomainEvent[] = [];

  private constructor(private props: OrderProps) {}

  static create(input: { tenantId: TenantId; name: string }): Order {
    const { normalized, tokens } = normalizeOrderName(input.name);
    const now = new Date();
    return new Order({
      id: OrderId.parse(newId('ord')),
      tenantId: input.tenantId,
      name: input.name,
      nameNormalized: normalized,
      nameTokens: tokens,
      status: 'DRAFT',
      items: [],
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Rehydrates from persistence. No validation — the data already passed
   *  it once, on the way in. */
  static reconstitute(props: OrderProps): Order {
    return new Order(props);
  }

  get id(): OrderId { return this.props.id; }
  get tenantId(): TenantId { return this.props.tenantId; }
  get status(): OrderStatus { return this.props.status; }
  get version(): number { return this.props.version; }
  get items(): readonly OrderItem[] { return this.props.items; }
  get snapshot(): Readonly<OrderProps> { return { ...this.props }; }

  addItem(item: OrderItem): void {
    if (this.props.status !== 'DRAFT') throw new OrderNotEditableError(this.props.status);
    this.props.items = [...this.props.items, item];
    this.props.updatedAt = new Date();
  }

  removeItem(itemId: string): void {
    if (this.props.status !== 'DRAFT') throw new OrderNotEditableError(this.props.status);
    this.props.items = this.props.items.filter((i) => i.id !== itemId);
    this.props.updatedAt = new Date();
  }

  moveToPricing(): void {
    if (this.props.items.length === 0) throw new EmptyOrderError();
    this.transitionTo('PRICING');
  }

  markReadyForCheckout(): void {
    this.transitionTo('READY_FOR_CHECKOUT');
  }

  transitionTo(to: OrderStatus): void {
    const from = this.props.status;
    if (!isLegalTransition(from, to)) throw new IllegalTransitionError(from, to);
    this.props.status = to;
    this.props.version += 1;
    this.props.updatedAt = new Date();
    this.pendingEvents.push(orderStatusChangedEvent(this.props.id, this.props.tenantId, from, to));
  }

  /** Drains and returns buffered events — the pattern a use case pairs with
   *  withOutbox: `{ result: order.snapshot, events: order.pullEvents() }`. */
  pullEvents(): DomainEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }
}
