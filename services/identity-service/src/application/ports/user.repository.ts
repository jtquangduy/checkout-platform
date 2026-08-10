import type { User } from '../../domain/user/user.entity.js';

export interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  insert(user: User): Promise<void>;
}
