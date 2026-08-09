import { MongoClient } from 'mongodb';
import type { Config } from './config.js';
import { createHttpServer } from './interface/http/create-http-server.js';

export async function compose(cfg: Config) {
  const mongo = new MongoClient(cfg.MONGO_URI);
  await mongo.connect();

  const app = createHttpServer();

  return {
    app,
    shutdown: async () => {
      await mongo.close();
    },
  };
}
