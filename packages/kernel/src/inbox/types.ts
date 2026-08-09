export interface InboxRecord {
  consumerGroup: string;
  messageId: string;
  state: 'IN_PROGRESS' | 'SUCCEEDED';
  claimedAt: Date;
  claimedBy: string;
  leaseExpiresAt: Date;
  processedAt?: Date;
  resultRef?: string;
}