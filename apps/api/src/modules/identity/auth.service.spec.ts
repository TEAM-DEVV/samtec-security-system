import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeThrottle } from '../../../test/fakes/fake-throttle.js';
import { FakeIdentityDb } from '../../../test/fakes/identity-db.js';
import { RateLimitException } from '../../common/rate-limit.exception.js';
import { AppConfig } from '../../config/app-config.js';
import { AccountsService } from './accounts.service.js';
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
  KIOSK_ORIGINS: ['http://localhost:5174'],
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
  const tokens = new TokensService(config);
  const audit = new AuditService(prisma);
  const accounts = new AccountsService(prisma, tokens, audit);
  const auth = new AuthService(prisma, tokens, throttle.asService(), audit, accounts);
  return { db, auth, throttle, accounts };
}

describe('login', () => {
  it('answers an unknown email and a wrong password identically', async () => {
    const { db, auth } = makeAuth();
    db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });

    const unknown = await auth
      .login('nobody@samtec.example', 'demo-password', 'DASHBOARD')
      .catch((e: unknown) => e);
    const wrong = await auth
      .login('ama@samtec.example', 'not-the-password', 'DASHBOARD')
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

    const outcome = await auth.login('ama@samtec.example', 'demo-password', 'DASHBOARD');

    expect(outcome.kind).toBe('session');
    if (outcome.kind !== 'session') throw new Error('unreachable');
    expect(outcome.session.user.email).toBe('ama@samtec.example');
    expect(outcome.refreshToken?.length ?? 0).toBeGreaterThan(20);
    expect(db.sessions).toHaveLength(1);
    expect(db.auditEntries).toContainEqual({ action: 'auth.signed_in', entityId: user.id });
  });

  it('is not case-sensitive about the email', async () => {
    const { db, auth } = makeAuth();
    db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });

    const outcome = await auth.login('  Ama@SAMTEC.example ', 'demo-password', 'DASHBOARD');

    expect(outcome.kind).toBe('session');
  });

  it('refuses a disabled account without revealing that it exists', async () => {
    const { db, auth } = makeAuth();
    db.addUser({ email: 'gone@samtec.example', passwordHash, role: 'SUPERVISOR', isActive: false });

    const error = await auth
      .login('gone@samtec.example', 'demo-password', 'DASHBOARD')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).message).toBe('Email or password is incorrect.');
  });

  it('locks an email after five wrong passwords, and audits the lockout for real accounts', async () => {
    const { db, auth } = makeAuth();
    const user = db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login('ama@samtec.example', 'guess', 'DASHBOARD').catch(() => undefined);
    }
    const locked = await auth
      .login('ama@samtec.example', 'guess', 'DASHBOARD')
      .catch((e: unknown) => e);

    expect(locked).toBeInstanceOf(RateLimitException);
    expect(db.auditEntries).toContainEqual({
      action: 'auth.lockout_triggered',
      entityId: user.id,
    });
  });

  it('locks an email that has no account too, revealing nothing', async () => {
    const { auth } = makeAuth();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login('nobody@samtec.example', 'guess', 'DASHBOARD').catch(() => undefined);
    }
    const locked = await auth
      .login('nobody@samtec.example', 'guess', 'DASHBOARD')
      .catch((e: unknown) => e);

    expect(locked).toBeInstanceOf(RateLimitException);
  });

  it('sends an ADMIN without two-factor authentication to set it up', async () => {
    const { db, auth } = makeAuth();
    db.addUser({ email: 'admin@samtec.example', passwordHash, role: 'ADMIN' });

    const outcome = await auth.login('admin@samtec.example', 'demo-password', 'DASHBOARD');

    expect(outcome.kind).toBe('setup');
    expect(db.sessions).toHaveLength(0); // Not signed in yet.
  });
});

describe('two-factor setup and verification', () => {
  async function setUpTwoFactor(role: 'ADMIN' | 'HR_PAYROLL' = 'HR_PAYROLL') {
    const { db, auth, throttle } = makeAuth();
    const user = db.addUser({ email: 'hr@samtec.example', passwordHash, role });
    const login = await auth.login('hr@samtec.example', 'demo-password', 'DASHBOARD');
    if (login.kind !== 'setup') throw new Error('Expected a setup outcome');
    const setupToken = login.response.setupToken;
    const setup = await auth.startTwoFactorSetup(setupToken, 'DASHBOARD');
    return { db, auth, throttle, user, setupToken, secret: setup.manualEntryKey };
  }

  it('turns two-factor on only after a correct code, then requires it at sign-in', async () => {
    const { db, auth, user, setupToken, secret } = await setUpTwoFactor();

    const wrong = await auth
      .enableTwoFactor(setupToken, '000000', 'DASHBOARD')
      .catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect(db.users[0]?.twoFactorEnabledAt).toBeNull();

    const result = await auth.enableTwoFactor(
      setupToken,
      totpCode(secret, totpStep()),
      'DASHBOARD',
    );
    expect(result.session.user.twoFactorEnabled).toBe(true);
    expect(db.users[0]?.twoFactorEnabledAt).not.toBeNull();
    expect(db.auditEntries).toContainEqual({
      action: 'auth.two_factor_enabled',
      entityId: user.id,
    });

    const nextLogin = await auth.login('hr@samtec.example', 'demo-password', 'DASHBOARD');
    expect(nextLogin.kind).toBe('challenge');
  });

  it('running setup again replaces the secret: codes from the first QR stop working', async () => {
    const { auth, setupToken, secret: firstSecret } = await setUpTwoFactor();

    const secondSetup = await auth.startTwoFactorSetup(setupToken, 'DASHBOARD');
    expect(secondSetup.manualEntryKey).not.toBe(firstSecret);

    const stale = await auth
      .enableTwoFactor(setupToken, totpCode(firstSecret, totpStep()), 'DASHBOARD')
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(UnauthorizedException);

    const fresh = await auth.enableTwoFactor(
      setupToken,
      totpCode(secondSetup.manualEntryKey, totpStep()),
      'DASHBOARD',
    );
    expect(fresh.session.status).toBe('AUTHENTICATED');
  });

  it('refuses a code that was already accepted (replay protection)', async () => {
    const { auth, setupToken, secret } = await setUpTwoFactor();
    const usedStep = totpStep();
    const usedCode = totpCode(secret, usedStep);
    await auth.enableTwoFactor(setupToken, usedCode, 'DASHBOARD');

    const login = await auth.login('hr@samtec.example', 'demo-password', 'DASHBOARD');
    if (login.kind !== 'challenge') throw new Error('Expected a challenge');
    const replay = await auth
      .verifyTwoFactor(login.response.challengeToken, usedCode, 'DASHBOARD')
      .catch((e: unknown) => e);
    expect(replay).toBeInstanceOf(UnauthorizedException);
    expect((replay as UnauthorizedException).message).toContain('already used');

    // The next step's code is fresh, so it works.
    const session = await auth.verifyTwoFactor(
      login.response.challengeToken,
      totpCode(secret, usedStep + 1),
      'DASHBOARD',
    );
    expect(session.session.status).toBe('AUTHENTICATED');
  });

  it('cancels the challenge after five wrong codes', async () => {
    const { auth, setupToken, secret } = await setUpTwoFactor();
    await auth.enableTwoFactor(setupToken, totpCode(secret, totpStep()), 'DASHBOARD');
    const login = await auth.login('hr@samtec.example', 'demo-password', 'DASHBOARD');
    if (login.kind !== 'challenge') throw new Error('Expected a challenge');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth
        .verifyTwoFactor(login.response.challengeToken, '000000', 'DASHBOARD')
        .catch(() => undefined);
    }
    // Even the right code is now refused: sign in with the password again.
    const done = await auth
      .verifyTwoFactor(login.response.challengeToken, totpCode(secret, totpStep() + 1), 'DASHBOARD')
      .catch((e: unknown) => e);

    expect(done).toBeInstanceOf(UnauthorizedException);
    expect((done as UnauthorizedException).message).toContain('expired');
  });

  it('caps code guessing per ACCOUNT: fresh sign-ins never grant fresh attempts', async () => {
    // The attack this stops: someone who KNOWS the password signs in over and
    // over, using each new challenge for 5 more code guesses. The per-account
    // totp throttle counts across challenges, so guessing still locks out.
    const { db, auth, user, setupToken, secret } = await setUpTwoFactor();
    await auth.enableTwoFactor(setupToken, totpCode(secret, totpStep()), 'DASHBOARD');

    // recordSuccess at enable reset the counter; now guess wrongly across
    // several fresh challenges: 3 on the first, 2 on the second.
    const first = await auth.login('hr@samtec.example', 'demo-password', 'DASHBOARD');
    if (first.kind !== 'challenge') throw new Error('Expected a challenge');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await auth
        .verifyTwoFactor(first.response.challengeToken, '000000', 'DASHBOARD')
        .catch(() => undefined);
    }
    const second = await auth.login('hr@samtec.example', 'demo-password', 'DASHBOARD');
    if (second.kind !== 'challenge') throw new Error('Expected a challenge');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await auth
        .verifyTwoFactor(second.response.challengeToken, '000000', 'DASHBOARD')
        .catch(() => undefined);
    }

    // Five wrong codes in total: the account's totp throttle is now locked,
    // so even a correct password cannot start another guessing round…
    const blockedLogin = await auth
      .login('hr@samtec.example', 'demo-password', 'DASHBOARD')
      .catch((e: unknown) => e);
    expect(blockedLogin).toBeInstanceOf(RateLimitException);
    // …and the still-open challenge is blocked too.
    const blockedVerify = await auth
      .verifyTwoFactor(
        second.response.challengeToken,
        totpCode(secret, totpStep() + 1),
        'DASHBOARD',
      )
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
    const outcome = await auth.login('ama@samtec.example', 'demo-password', 'DASHBOARD');
    if (outcome.kind !== 'session' || !outcome.refreshToken) {
      throw new Error('Expected a session with a refresh token');
    }
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

describe('sessions an administrator ended', () => {
  it('answers 401 for an ended session WITHOUT the stolen-token alarm', async () => {
    // An admin action ends every session. The person's other browser still
    // holds its old cookie; using it must not sign them out of the session
    // they create next, and must not record a false theft.
    const { db, auth, accounts } = makeAuth();
    const user = db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });
    const first = await auth.login('ama@samtec.example', 'demo-password', 'DASHBOARD');
    if (first.kind !== 'session' || !first.refreshToken) throw new Error('Expected a session');

    await accounts.endAllAccess(user.id);
    const second = await auth.login('ama@samtec.example', 'demo-password', 'DASHBOARD');
    if (second.kind !== 'session' || !second.refreshToken) throw new Error('Expected a session');

    const stale = await auth.refresh(first.refreshToken).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(UnauthorizedException);
    expect(db.auditEntries.map((entry) => entry.action)).not.toContain(
      'auth.refresh_reuse_detected',
    );
    // The new session is untouched.
    await expect(auth.refresh(second.refreshToken)).resolves.toBeDefined();
  });

  it('refuses a switched-off account at refresh, and ends that session too', async () => {
    const { db, auth } = makeAuth();
    const user = db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });
    const outcome = await auth.login('ama@samtec.example', 'demo-password', 'DASHBOARD');
    if (outcome.kind !== 'session' || !outcome.refreshToken) throw new Error('Expected a session');

    user.isActive = false;
    const refused = await auth.refresh(outcome.refreshToken).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnauthorizedException);
    expect(db.sessions.every((session) => session.revokedAt !== null)).toBe(true);
  });

  it('refuses an ADMIN without two-factor at refresh (promotion backstop)', async () => {
    const { db, auth } = makeAuth();
    const user = db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });
    const outcome = await auth.login('ama@samtec.example', 'demo-password', 'DASHBOARD');
    if (outcome.kind !== 'session' || !outcome.refreshToken) throw new Error('Expected a session');

    // Promoted in the same instant as a refresh: no ADMIN token without a second factor.
    user.role = 'ADMIN';
    const refused = await auth.refresh(outcome.refreshToken).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnauthorizedException);
  });
});

describe('choosing a password with a one-time link', () => {
  it('lets the person choose their own password, once', async () => {
    const { db, auth, accounts } = makeAuth();
    const user = db.addUser({ email: 'new@samtec.example', passwordHash: null, role: 'GUARD' });
    const { token } = await accounts.issuePasswordSetup(user.id);

    // Before choosing a password the account cannot sign in at all.
    const early = await auth
      .login('new@samtec.example', 'anything-at-all', 'DASHBOARD')
      .catch((e) => e);
    expect(early).toBeInstanceOf(UnauthorizedException);

    await auth.setPassword(token, 'correct horse battery staple');
    const outcome = await auth.login(
      'new@samtec.example',
      'correct horse battery staple',
      'DASHBOARD',
    );
    expect(outcome.kind).toBe('session');

    // The link worked once and is gone.
    const again = await auth.setPassword(token, 'another long password').catch((e) => e);
    expect(again).toBeInstanceOf(BadRequestException);
    expect(db.auditEntries.map((entry) => entry.action)).toContain('auth.password_set');
  });

  it('refuses an expired link and a made-up one with the same 400', async () => {
    const { db, auth, accounts } = makeAuth();
    const user = db.addUser({ email: 'new@samtec.example', passwordHash: null, role: 'GUARD' });
    const { token } = await accounts.issuePasswordSetup(user.id);
    for (const challenge of db.challenges) challenge.expiresAt = new Date(Date.now() - 1000);

    const expired = await auth.setPassword(token, 'correct horse battery staple').catch((e) => e);
    const madeUp = await auth
      .setPassword('not-a-real-link', 'correct horse battery')
      .catch((e) => e);
    expect(expired).toBeInstanceOf(BadRequestException);
    expect((madeUp as BadRequestException).getResponse()).toEqual(
      (expired as BadRequestException).getResponse(),
    );
  });
});

describe('changing your own password', () => {
  it('answers a wrong current password with 400 (never 401) and counts it', async () => {
    const { db, auth, throttle } = makeAuth();
    const user = db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });

    const wrong = await auth
      .changePassword(user.id, 'not-my-password', 'a brand new long password')
      .catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(BadRequestException);
    expect(throttle.failures.get('password:ama@samtec.example')).toBe(1);
  });

  it('refuses the same password again', async () => {
    const { db, auth } = makeAuth();
    const user = db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });
    const same = await auth
      .changePassword(user.id, 'demo-password', 'demo-password')
      .catch((e: unknown) => e);
    expect(same).toBeInstanceOf(BadRequestException);
  });

  it('saves the new password, ends every session, and audits no secrets', async () => {
    const { db, auth } = makeAuth();
    const user = db.addUser({ email: 'ama@samtec.example', passwordHash, role: 'SUPERVISOR' });
    const outcome = await auth.login('ama@samtec.example', 'demo-password', 'DASHBOARD');
    if (outcome.kind !== 'session' || !outcome.refreshToken) throw new Error('Expected a session');

    await auth.changePassword(user.id, 'demo-password', 'a brand new long password');

    expect(db.sessions.every((session) => session.revokedAt !== null)).toBe(true);
    const oldPassword = await auth
      .login('ama@samtec.example', 'demo-password', 'DASHBOARD')
      .catch((e) => e);
    expect(oldPassword).toBeInstanceOf(UnauthorizedException);
    const fresh = await auth.login('ama@samtec.example', 'a brand new long password', 'DASHBOARD');
    expect(fresh.kind).toBe('session');
    expect(JSON.stringify(db.auditRows)).not.toContain('brand new');
  });
});
