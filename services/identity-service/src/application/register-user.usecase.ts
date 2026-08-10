import { newId, TenantId, UserId } from '@platform/contracts';
import { hashPassword } from '../domain/user/password.js';
import { EmailAlreadyRegisteredError } from '../domain/errors.js';
import type { Role } from '../domain/user/roles.js';
import type { User } from '../domain/user/user.entity.js';
import type { UserRepository } from './ports/user.repository.js';

export interface RegisterUserCommand {
  tenantId: TenantId;
  email: string;
  name: string;
  password: string;
  roles: Role[];
}

export class RegisterUserUseCase {
  constructor(private readonly users: UserRepository) {}

  async execute(cmd: RegisterUserCommand): Promise<User> {
    const existing = await this.users.findByEmail(cmd.email);
    if (existing) throw new EmailAlreadyRegisteredError(cmd.email);

    const now = new Date();
    const user: User = {
      id: UserId.parse(newId('usr')),
      tenantId: cmd.tenantId,
      email: cmd.email,
      name: cmd.name,
      passwordHash: await hashPassword(cmd.password),
      roles: cmd.roles,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };

    await this.users.insert(user);
    return user;
  }
}
