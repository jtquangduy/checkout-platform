import { Router, type Router as RouterType } from 'express';

export function jwksRoute(jwks: { keys: unknown[] }): RouterType {
  const router = Router();
  router.get('/.well-known/jwks.json', (_req, res) => {
    res.status(200).json(jwks);
  });
  return router;
}
