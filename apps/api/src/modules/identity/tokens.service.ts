import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { AppConfig } from '../../config/app-config.js';
import { deriveKey, openSecret, sealSecret } from './secret-box.js';

/** Access tokens are short-lived on purpose: a stolen one dies within 15 minutes. */
export const ACCESS_TOKEN_SECONDS = 15 * 60;

const JWT_ISSUER = 'samtec-api';
const JWT_AUDIENCE = 'samtec-dashboard';

/**
 * Makes and checks the tokens sign-in runs on.
 *
 * - **Access tokens** are JWTs: signed statements of who the caller is. The
 *   signature proves the token is genuine; `AccessTokenGuard` then also checks
 *   the account is still usable and unchanged, so a switched-off account's
 *   token stops working at once.
 * - **Refresh, challenge and password-link tokens** are plain random strings. The database
 *   stores only their SHA-256 hash, so a stolen database backup contains no
 *   usable tokens.
 *
 * All keys are derived from the one AUTH_SECRET (see secret-box.ts).
 */
@Injectable()
export class TokensService {
  private readonly jwtKey: Buffer;
  private readonly boxKey: Buffer;

  constructor(config: AppConfig) {
    this.jwtKey = deriveKey(config.authSecret, 'access-token');
    this.boxKey = deriveKey(config.authSecret, 'secret-box');
  }

  /** Signs a 15-minute access token that says who the caller is. */
  async signAccessToken(user: SignedInUser): Promise<string> {
    return new SignJWT({ role: user.role, cid: user.companyId, eid: user.employeeId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.userId)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_SECONDS}s`)
      .sign(this.jwtKey);
  }

  /** Checks an access token. Returns who the caller is, or null for anything invalid. */
  async verifyAccessToken(token: string): Promise<SignedInUser | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwtKey, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.role !== 'string' ||
        typeof payload.cid !== 'string'
      ) {
        return null;
      }
      return {
        userId: payload.sub,
        role: payload.role as SignedInUser['role'],
        companyId: payload.cid,
        employeeId: typeof payload.eid === 'string' ? payload.eid : null,
      };
    } catch {
      return null;
    }
  }

  /** A fresh unguessable token for a refresh cookie or a sign-in challenge. */
  newOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** The hash under which an opaque token is stored and looked up. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Encrypts an authenticator secret for storage. */
  encryptSecret(secret: string): string {
    return sealSecret(secret, this.boxKey);
  }

  /** Decrypts a stored authenticator secret, or null if it was tampered with. */
  decryptSecret(sealed: string): string | null {
    return openSecret(sealed, this.boxKey);
  }
}
