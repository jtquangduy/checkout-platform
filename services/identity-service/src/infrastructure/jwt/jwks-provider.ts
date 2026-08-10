import { exportJWK, type KeyLike } from 'jose';

export async function buildJwks(publicKey: KeyLike, kid: string) {
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
}
