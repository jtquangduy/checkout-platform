import { SignJWT, type KeyLike } from 'jose';
import { newId } from '@platform/contracts';
import type { AccessTokenClaims, TokenIssuer } from '../../application/ports/token-issuer.js';

export interface JoseTokenIssuerOptions {
  privateKey: KeyLike;
  kid: string;
  issuer: string;
  audience: string;
  accessTokenTtl: string;
}

export class JoseTokenIssuer implements TokenIssuer {
  constructor(private readonly opts: JoseTokenIssuerOptions) {}

  async issueAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ tid: claims.tid, roles: claims.roles })
      .setProtectedHeader({ alg: 'RS256', kid: this.opts.kid })
      .setIssuer(this.opts.issuer)
      .setAudience(this.opts.audience)
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(this.opts.accessTokenTtl)
      .setJti(newId('jwt'))
      .sign(this.opts.privateKey);
  }
}
