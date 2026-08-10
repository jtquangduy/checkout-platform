import type { Collection } from 'mongodb';
import type { User } from '../../domain/user/user.entity.js';
import type { UserRepository } from '../../application/ports/user.repository.js';

/** Deliberately NOT tenant-scoped: at login time the caller hasn't proven
 *  which tenant they belong to yet — tenant is discovered AS A RESULT of
 *  this lookup, not a precondition for it. Safe because email is globally
 *  unique across the whole platform (DATA-MODEL.md's unique index), not
 *  per-tenant. */
export class MongoUserRepository implements UserRepository {
  constructor(private readonly col: Collection<User>) {}

  findByEmail(email: string) {
    return this.col.findOne({ email });
  }

  async insert(user: User): Promise<void> {
    await this.col.insertOne(user);
  }
}
