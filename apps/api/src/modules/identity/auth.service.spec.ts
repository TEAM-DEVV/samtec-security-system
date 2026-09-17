import { UnauthorizedException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeThrottle } from '../../../test/fakes/fake-throttle.js';
import { FakeIdentityDb } from '../../../test/fakes/identity-db.js';
import { RateLimitException } from '../../common/rate-limit.exception.js';
import { AppConfig } from '../../config/app-config.js';
import { AuditService } from './audit.service.js';
import { AuthService } from './auth.service.js';
import { hashPassword, TEST_ONLY_SCRYPT_PARAMS } from './password.js';
import { TokensService } from './tokens.service.js';
import { totpCode, totpStep } from './totp.js';

/**
 * The sign-in flows against a fake in-memory database and throttle. The same
 * flows also run against real PostgreSQL in test/db.e2e-spec.ts.
 */

const config = new AppConfig({
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgresql://unused@localhost:5432/unused',
  CORS_ORIGINS: ['http://localhost:5173'],
  AUTH_SECRET: 'test-only-auth-secret-at-least-32-chars!',
});

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword('demo-password', TEST_ONLY_SCRYPT_PARAMS);
});

function makeAuth() {
  const db = new FakeIdentityDb();
  const prisma = db.asPrisma();
  const throttle = new FakeThrottle();
  const auth = new AuthService(
    prisma,
    new TokensService(config),
    throttle.asService(),
    new AuditService(prisma),
  );
  return { db, auth, throttle };
}

describe('login', () => {
  it('answers an unknown email and a wrong password identically', async () => {
    const { db, auth } = makeAuth();
    db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });

    const unknown = await auth
      .login('nobody@samtec.example', 'demo-password')
      .catch((e: unknown) => e);
    const wrong = await auth
      .login('ama@samtec.example', 'not-the-password')
      .catch((e: unknown) => e);

    expect(unknown).toBeInstanceOf(UnauthorizedException);
    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect((unknown as UnauthorizedException).message).toBe(
      (wrong as UnauthorizedException).message,
    );
  });

  it('signs a supervisor straight in and writes an audit entry', async () => {
    const { db, auth } = makeAuth();
    const user = db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });

    const outcome = await auth.login('ama@samtec.example', 'demo-password');

    expect(outcome.kind).toBe('session');
    if (outcome.kind !== 'session') throw new Error('unreachable');
    expect(outcome.session.user.email).toBe('ama@samtec.example');
    expect(outcome.refreshToken.length).toBeGreaterThan(20);
    expect(db.sessions).toHaveLength(1);
    expect(db.auditEntries).toContainEqual({ action: 'auth.signed_in', entityId: user.id });
  });

  it('is not case-sensitive about the email', async () => {
    const { db, auth } = makeAuth();
    db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });

    const outcome = await auth.login('  Ama@SAMTEC.example ', 'demo-password');

    expect(outcome.kind).toBe('session');
  });

  it('refuses a disabled account without revealing that it exists', async () => {
    const { db, auth } = makeAuth();
    db.addUser({ email: 'gone@samtec.example', passwordHash, role: 'SUPERVISOR', isActive: false });

    const error = await auth.login('gone@samtec.example', 'demo-password').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).message).toBe('Email or password is incorrect.');
  });

  it('locks an email after five wrong passwords, and audits the lockout for real accounts', async () => {
    const { db, auth } = makeAuth();
    const user = db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login('ama@samtec.example', 'guess').catch(() => undefined);
    }
    const locked = await auth.login('ama@samtec.example', 'guess').catch((e: unknown) => e);

    expect(locked).toBeInstanceOf(RateLimitException);
    expect(db.auditEntries).toContainEqual({
      action: 'auth.lockout_triggered',
      entityId: user.id,
    });
  });

  it('locks an email that has no account too, revealing nothing', async () => {
    const { auth } = makeAuth();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login('nobody@samtec.example', 'guess').catch(() => undefined);
    }
    const locked = await auth.login('nobody@samtec.example', 'guess').catch((e: unknown) => e);

    expect(locked).toBeInstanceOf(RateLimitException);
  });

  it('sends an ADMIN without two-factor authentication to set it up', async () => {
    const { db, auth } = makeAuth();
    db.addUser({ email: 'admin@samtec.example', passwordHash, role: 'ADMIN' });

    const outcome = await auth.login('admin@samtec.example', 'demo-password');

    expect(outcome.kind).toBe('setup');
    expect(db.sessions).toHaveLength(0); // Not signed in yet.
  });
});

describe('two-factor setup and verification', () => {
  async function setUpTwoFactor(role: 'ADMIN' | 'HR_PAYROLL' = 'HR_PAYROLL') {
    const { db, auth, throttle } = makeAuth();
    const user = db.addUser({ email: 'hr@samtec.example', passwordHash, role });
    const login = await auth.login('hr@samtec.example', 'demo-password');
    if (login.kind !== 'setup') throw new Error('Expected a setup outcome');
    const setupToken = login.response.setupToken;
    const setup = await auth.startTwoFactorSetup(setupToken);
    return { db, auth, throttle, user, setupToken, secret: setup.manualEntryKey };
  }

  it('turns two-factor on only after a correct code, then requires it at sign-in', async () => {
    const { db, auth, user, setupToken, secret } = await setUpTwoFactor();

    const wrong = await auth.enableTwoFactor(setupToken, '000000').catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect(db.users[0]?.twoFactorEnabledAt).toBeNull();

    const result = await auth.enableTwoFactor(setupToken, totpCode(secret, totpStep()));
    expect(result.session.user.twoFactorEnabled).toBe(true);
    expect(db.users[0]?.twoFactorEnabledAt).not.toBeNull();
    expect(db.auditEntries).toContainEqual({
      action: 'auth.two_factor_enabled',
      entityId: user.id,
    });

    const nextLogin = await auth.login('hr@samtec.example', 'demo-password');
    expect(nextLogin.kind).toBe('challenge');
  });

  it('running setup again replaces the secret: codes from the first QR stop working', async () => {
    const { auth, setupToken, secret: firstSecret } = await setUpTwoFactor();

    const secondSetup = await auth.startTwoFactorSetup(setupToken);
    expect(secondSetup.manualEntryKey).not.toBe(firstSecret);

    const stale = await auth
      .enableTwoFactor(setupToken, totpCode(firstSecret, totpStep()))
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(UnauthorizedException);

    const fresh = await auth.enableTwoFactor(
      setupToken,
      totpCode(secondSetup.manualEntryKey, totpStep()),
    );
    expect(fresh.session.status).toBe('AUTHENTICATED');
  });

  it('refuses a code that was already accepted (replay protection)', async () => {
    const { auth, setupToken, secret } = await setUpTwoFactor();
    const usedStep = totpStep();
    const usedCode = totpCode(secret, usedStep);
    await auth.enableTwoFactor(setupToken, usedCode);

    const login = await auth.login('hr@samtec.example', 'demo-password');
    if (login.kind !== 'challenge') throw new Error('Expected a challenge');
    const replay = await auth
      .verifyTwoFactor(login.response.challengeToken, usedCode)
      .catch((e: unknown) => e);
    expect(replay).toBeInstanceOf(UnauthorizedException);
    expect((replay as UnauthorizedException).message).toContain('already used');

    // The next step's code is fresh, so it works.
    const session = await auth.verifyTwoFactor(
      login.response.challengeToken,
      totpCode(secret, usedStep + 1),
    );
    expect(session.session.status).toBe('AUTHENTICATED');
  });

  it('cancels the challenge after five wrong codes', async () => {
    const { auth, setupToken, secret } = await setUpTwoFactor();
    await auth.enableTwoFactor(setupToken, totpCode(secret, totpStep()));
    const login = await auth.login('hr@samtec.example', 'demo-password');
    if (login.kind !== 'challenge') throw new Error('Expected a challenge');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.verifyTwoFactor(login.response.challengeToken, '000000').catch(() => undefined);
    }
    // Even the right code is now refused: sign in with the password again.
    const done = await auth
      .verifyTwoFactor(login.response.challengeToken, totpCode(secret, totpStep() + 1))
      .catch((e: unknown) => e);

    expect(done).toBeInstanceOf(UnauthorizedException);
    expect((done as UnauthorizedException).message).toContain('expired');
  });

  it('caps code guessing per ACCOUNT: fresh sign-ins never grant fresh attempts', async () => {
    // The attack this stops: someone who KNOWS the password signs in over and
    // over, using each new challenge for 5 more code guesses. The per-account
    // totp throttle counts across challenges, so guessing still locks out.
    const { db, auth, user, setupToken, secret } = await setUpTwoFactor();
    await auth.enableTwoFactor(setupToken, totpCode(secret, totpStep()));

    // recordSuccess at enable reset the counter; now guess wrongly across
    // several fresh challenges: 3 on the first, 2 on the second.
    const first = await auth.login('hr@samtec.example', 'demo-password');
    if (first.kind !== 'challenge') throw new Error('Expected a challenge');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await auth.verifyTwoFactor(first.response.challengeToken, '000000').catch(() => undefined);
    }
    const second = await auth.login('hr@samtec.example', 'demo-password');
    if (second.kind !== 'challenge') throw new Error('Expected a challenge');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await auth.verifyTwoFactor(second.response.challengeToken, '000000').catch(() => undefined);
    }

    // Five wrong codes in total: the account's totp throttle is now locked,
    // so even a correct password cannot start another guessing round…
    const blockedLogin = await auth
      .login('hr@samtec.example', 'demo-password')
      .catch((e: unknown) => e);
    expect(blockedLogin).toBeInstanceOf(RateLimitException);
    // …and the still-open challenge is blocked too.
    const blockedVerify = await auth
      .verifyTwoFactor(second.response.challengeToken, totpCode(secret, totpStep() + 1))
      .catch((e: unknown) => e);
    expect(blockedVerify).toBeInstanceOf(RateLimitException);
    expect(db.auditEntries).toContainEqual({
      action: 'auth.lockout_triggered',
      entityId: user.id,
    });
  });
});

describe('refresh token rotation', () => {
  async function signedInSupervisor() {
    const { db, auth } = makeAuth();
    db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });
    const outcome = await auth.login('ama@samtec.example', 'demo-password');
    if (outcome.kind !== 'session') throw new Error('Expected a session');
    return { db, auth, refreshToken: outcome.refreshToken };
  }

  it('rotates the refresh token on every use', async () => {
    const { auth, refreshToken } = await signedInSupervisor();

    const first = await auth.refresh(refreshToken);
    expect(first.accessToken.length).toBeGreaterThan(20);
    expect(first.refreshToken).not.toBe(refreshToken);

    const second = await auth.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
  });

  it('revokes every session when a rotated token is used again', async () => {
    const { db, auth, refreshToken } = await signedInSupervisor();
    const rotated = await auth.refresh(refreshToken);

    // The old token arrives again: someone copied it.
    const reuse = await auth.refresh(refreshToken).catch((e: unknown) => e);
    expect(reuse).toBeInstanceOf(UnauthorizedException);

    // Now even the newest token is dead: everyone is signed out.
    const after = await auth.refresh(rotated.refreshToken).catch((e: unknown) => e);
    expect(after).toBeInstanceOf(UnauthorizedException);
    expect(db.auditEntries.map((entry) => entry.action)).toContain('auth.refresh_reuse_detected');
  });

  it('lets at most one of two RACING refreshes win, and kills every session after', async () => {
    // Two requests replay the same token at the same moment (a stolen token
    // used in parallel with the real one). The atomic "claim" means at most
    // one can mint a session, and the loser triggers revoke-everything.
    const { db, auth, refreshToken } = await signedInSupervisor();

    const results = await Promise.allSettled([
      auth.refresh(refreshToken),
      auth.refresh(refreshToken),
    ]);

    const wins = results.filter((result) => result.status === 'fulfilled');
    expect(wins.length).toBeLessThanOrEqual(1);
    // The loser always trips the alarm: reuse is detected and audited.
    expect(db.auditEntries.map((entry) => entry.action)).toContain('auth.refresh_reuse_detected');
    // And the replayed token itself is dead for good.
    const replayAgain = await auth.refresh(refreshToken).catch((e: unknown) => e);
    expect(replayAgain).toBeInstanceOf(UnauthorizedException);
  });

  it('signs out by revoking the session, and signing out twice is fine', async () => {
    const { auth, refreshToken } = await signedInSupervisor();

    await auth.logout(refreshToken);
    await auth.logout(refreshToken);
    await auth.logout(undefined);

    const error = await auth.refresh(refreshToken).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedException);
  });
});
