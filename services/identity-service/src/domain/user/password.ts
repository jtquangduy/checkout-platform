import * as argon2 from 'argon2';

// Per SECURITY.md: Argon2id, 64 MB memory, never bcrypt at a low cost factor.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
