import { verifyPassword } from '../domain/user/password.js';
import { InvalidCredentialsError } from '../domain/errors.js';
import type { UserRepository } from './ports/user.repository.js';
import type { TokenIssuer } from './ports/token-issuer.js';

export interface LoginCommand {
  email: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
}

export class LoginUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly tokens: TokenIssuer,
  ) {}

  async execute(cmd: LoginCommand): Promise<LoginResult> {
    const user = await this.users.findByEmail(cmd.email);
    // Same error for "no such user" and "wrong password" — never let login
    // become a tool for discovering which emails are registered.
    if (!user || user.status !== 'ACTIVE') throw new InvalidCredentialsError();

    const valid = await verifyPassword(cmd.password, user.passwordHash);
    if (!valid) throw new InvalidCredentialsError();

    const accessToken = await this.tokens.issueAccessToken({
      sub: user.id,
      tid: user.tenantId,
      roles: user.roles,
    });

    return { accessToken };
  }
}
