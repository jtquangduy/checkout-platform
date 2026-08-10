import { Router, type Router as RouterType } from 'express';
import type { LoginUseCase } from '../../../application/login.usecase.js';
import { InvalidCredentialsError } from '../../../domain/errors.js';
import { LoginRequestSchema } from '../schemas.js';

export function loginRoute(loginUseCase: LoginUseCase): RouterType {
  const router = Router();

  router.post('/login', async (req, res) => {
    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
      return;
    }

    try {
      const result = await loginUseCase.execute(parsed.data);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        res.status(401).json({ error: 'INVALID_CREDENTIALS' });
        return;
      }
      throw err; // Express 5 forwards thrown errors from async handlers automatically
    }
  });

  return router;
}
