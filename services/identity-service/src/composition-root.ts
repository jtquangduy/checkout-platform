import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { importPKCS8, importSPKI } from 'jose';
import type { Config } from './config.js';
import { createHttpServer } from './interface/http/create-http-server.js';
import { loginRoute } from './interface/http/routes/login.route.js';
import { jwksRoute } from './interface/http/routes/jwks.route.js';
import { MongoUserRepository } from './infrastructure/mongo/user.mongo.repository.js';
import { ensureUserIndexes } from './infrastructure/mongo/ensure-indexes.js';
import { JoseTokenIssuer } from './infrastructure/jwt/jose-token-issuer.js';
import { buildJwks } from './infrastructure/jwt/jwks-provider.js';
import { LoginUseCase } from './application/login.usecase.js';
import { RegisterUserUseCase } from './application/register-user.usecase.js';
import type { User } from './domain/user/user.entity.js';

export async function compose(cfg: Config) {
  const mongo = new MongoClient(cfg.MONGO_URI);
  await mongo.connect();
  const db = mongo.db(cfg.MONGO_DB_NAME);
  await ensureUserIndexes(db);

  const privateKey = await importPKCS8(readFileSync(cfg.JWT_PRIVATE_KEY_PATH, 'utf-8'), 'RS256');
  const publicKey = await importSPKI(readFileSync(cfg.JWT_PUBLIC_KEY_PATH, 'utf-8'), 'RS256');

  const users = new MongoUserRepository(db.collection<User>('users'));
  const tokens = new JoseTokenIssuer({
    privateKey,
    kid: cfg.JWT_KID,
    issuer: cfg.JWT_ISSUER,
    audience: cfg.JWT_AUDIENCE,
    accessTokenTtl: cfg.JWT_ACCESS_TOKEN_TTL,
  });
  const jwks = await buildJwks(publicKey, cfg.JWT_KID);

  const registerUser = new RegisterUserUseCase(users);
  const login = new LoginUseCase(users, tokens);
  const app = createHttpServer({ routers: [loginRoute(login), jwksRoute(jwks)], env: cfg.NODE_ENV });

  return {
    app,
    registerUser, // exposed so the seed script can use it
    shutdown: async () => { await mongo.close(); },
  };
}
