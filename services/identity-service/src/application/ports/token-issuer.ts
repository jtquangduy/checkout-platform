export interface AccessTokenClaims {
  sub: string;
  tid: string;
  roles: string[];
}

export interface TokenIssuer {
  issueAccessToken(claims: AccessTokenClaims): Promise<string>;
}