import amqplib, { type ChannelModel, type ConfirmChannel } from 'amqplib';

export const EXCHANGE = 'checkout.events';

export interface RabbitConnection {
  connection: ChannelModel;
  channel: ConfirmChannel;
  close(): Promise<void>;
}

export async function connectRabbit(url: string): Promise<RabbitConnection> {
  const connection = await amqplib.connect(url);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  return {
    connection,
    channel,
    async close() {
      await channel.close();
      await connection.close();
    },
  };
}
