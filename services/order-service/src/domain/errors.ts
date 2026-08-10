export class IllegalTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition order from ${from} to ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export class EmptyOrderError extends Error {
  constructor() {
    super('An order must have at least one item before it can be priced');
    this.name = 'EmptyOrderError';
  }
}

export class OrderNotEditableError extends Error {
  constructor(status: string) {
    super(`Cannot modify items while order is ${status}`);
    this.name = 'OrderNotEditableError';
  }
}
