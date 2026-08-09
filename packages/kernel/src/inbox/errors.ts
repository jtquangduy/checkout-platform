export class ConcurrentDeliveryError extends Error {
  constructor(messageId: string) {
    super(`Message ${messageId} is currently being processed by another consumer`);
    this.name = 'ConcurrentDeliveryError';
  }
}
