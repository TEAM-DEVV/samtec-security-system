import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RateLimitException } from '../../common/rate-limit.exception.js';
import { AppConfig } from '../../config/app-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { deriveKey } from './secret-box.js';

/** This many failures inside the window lock a key out. */
const MAX_FAILURES = 5;

/**
 * How long each kind counts and locks for. Sign-in guessing is a burst, so
 * its windows are short; a Ghana Card check happens once per enrollment, so
 * five wrong answers mean the worker waits an hour (docs/plan/13 section 2).
 */
const WINDOWS: Record<ThrottleKind, { windowMinutes: number; lockMinutes: number }> = {
  password: { windowMinutes: 15, lockMinutes: 15 },
  totp: { windowMinutes: 15, lockMinutes: 15 },
  'ghana-card': { windowMinutes: 60, lockMinutes: 60 },
};

/**
 * What is being throttled:
 * - `password`: wrong passwords, counted per email — whether or not the email
 *   has an account, so the lockout itself reveals nothing.
 * - `totp`: wrong two-factor codes, counted per account. This is what stops
 *   someone who *knows* the password from guessing the 6-digit code: signing
 *   in again gets fresh challenges, but never fresh code attempts.
 * - `ghana-card`: wrong answers to "the last 4 digits of this worker's card"
 *   at a kiosk, counted per worker.
 */
export type ThrottleKind = 'password' | 'totp' | 'ghana-card';

/**
 * Slows guessing down: five failures for one key inside 15 minutes lock it
 * for 15 minutes, and further tries answer 429 with a `Retry-After` header.
 *
 * The counting is one atomic SQL statement, so many attempts fired in
 * parallel are all counted — a read-then-write version could lose counts in
 * that race and let a scripted attacker through. (Raw SQL is rare in this
 * project and needs both developers' review; this atomicity is why it is
 * used here.)
 *
 * Keys are stored only as HMACs keyed from AUTH_SECRET: even with the table
 * in hand, nobody can turn it back into the emails people typed.
 */
@Injectable()
export class SignInThrottleService {
  private readonly hmacKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    config: AppConfig,
  ) {
    this.hmacKey = deriveKey(config.authSecret, 'sign-in-throttle');
  }

  /** Throws 429 when this key is locked out. Call before checking a password or code. */
  async assertNotLocked(kind: ThrottleKind, value: string): Promise<void> {
    const row = await this.prisma.signInThrottle.findUnique({
      where: { keyHash: this.hashKey(kind, value) },
    });
    if (!row?.lockedUntil) {
      return;
    }
    const waitSeconds = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 1000);
    if (waitSeconds > 0) {
      throw new RateLimitException(
        `Too many attempts. Try again in ${waitSeconds} seconds.`,
        waitSeconds,
      );
    }
  }

  /** Counts one failure. Returns true when this failure caused a lockout. */
  async recordFailure(kind: ThrottleKind, value: string): Promise<boolean> {
    const keyHash = this.hashKey(kind, value);
    const { windowMinutes, lockMinutes } = WINDOWS[kind];
    // One statement that inserts or updates, resets an expired window, and
    // sets the lock — atomically, using the database's own clock. `EXCLUDED`
    // is PostgreSQL's name for the row we tried to insert.
    const rows = await this.prisma.$queryRaw<Array<{ locked_until: Date | null }>>`
      INSERT INTO sign_in_throttles (key_hash, failed_count, window_starts_at, locked_until, created_at, updated_at)
      VALUES (${keyHash}, 1, now(), NULL, now(), now())
      ON CONFLICT (key_hash) DO UPDATE SET
        failed_count = CASE
          WHEN sign_in_throttles.window_starts_at < now() - ${windowMinutes} * interval '1 minute'
            THEN 1
          ELSE sign_in_throttles.failed_count + 1
        END,
        window_starts_at = CASE
          WHEN sign_in_throttles.window_starts_at < now() - ${windowMinutes} * interval '1 minute'
            THEN now()
          ELSE sign_in_throttles.window_starts_at
        END,
        locked_until = CASE
          WHEN (CASE
            WHEN sign_in_throttles.window_starts_at < now() - ${windowMinutes} * interval '1 minute'
              THEN 1
            ELSE sign_in_throttles.failed_count + 1
          END) >= ${MAX_FAILURES}
            THEN now() + ${lockMinutes} * interval '1 minute'
          ELSE NULL
        END,
        updated_at = now()
      RETURNING locked_until
    `;
    return rows[0]?.locked_until != null;
  }

  /**
   * Takes one attempt **before** it is judged, and throws 429 when this key
   * has no attempts left. Counting and deciding happen in the one statement,
   * so a burst of requests sent at the same moment cannot all read "not
   * locked yet" and each get a free guess — which is exactly what a plain
   * `assertNotLocked` then `recordFailure` pair allows.
   *
   * Use this where the thing being guessed is short (the last 4 digits of a
   * Ghana Card); `recordSuccess` still wipes the slate on a right answer.
   */
  async claimAttempt(kind: ThrottleKind, value: string): Promise<void> {
    const keyHash = this.hashKey(kind, value);
    const { windowMinutes, lockMinutes } = WINDOWS[kind];
    const rows = await this.prisma.$queryRaw<
      Array<{ failed_count: number; locked_until: Date | null }>
    >`
      INSERT INTO sign_in_throttles (key_hash, failed_count, window_starts_at, locked_until, created_at, updated_at)
      VALUES (${keyHash}, 1, now(), NULL, now(), now())
      ON CONFLICT (key_hash) DO UPDATE SET
        failed_count = CASE
          WHEN sign_in_throttles.window_starts_at < now() - ${windowMinutes} * interval '1 minute'
            THEN 1
          ELSE sign_in_throttles.failed_count + 1
        END,
        window_starts_at = CASE
          WHEN sign_in_throttles.window_starts_at < now() - ${windowMinutes} * interval '1 minute'
            THEN now()
          ELSE sign_in_throttles.window_starts_at
        END,
        locked_until = CASE
          WHEN sign_in_throttles.window_starts_at < now() - ${windowMinutes} * interval '1 minute'
            THEN NULL
          WHEN sign_in_throttles.failed_count + 1 > ${MAX_FAILURES}
            THEN now() + ${lockMinutes} * interval '1 minute'
          ELSE sign_in_throttles.locked_until
        END,
        updated_at = now()
      RETURNING failed_count, locked_until
    `;
    // The count decides, and it came from the same statement that wrote it:
    // attempts beyond the allowance are refused however many arrive at once.
    const row = rows[0];
    if (!row || row.failed_count <= MAX_FAILURES) {
      return;
    }
    const waitSeconds = row.locked_until
      ? Math.max(1, Math.ceil((row.locked_until.getTime() - Date.now()) / 1000))
      : WINDOWS[kind].lockMinutes * 60;
    throw new RateLimitException(
      `Too many attempts. Try again in ${waitSeconds} seconds.`,
      waitSeconds,
    );
  }

  /** A correct password or code wipes that key's slate clean. */
  async recordSuccess(kind: ThrottleKind, value: string): Promise<void> {
    await this.prisma.signInThrottle
      .delete({ where: { keyHash: this.hashKey(kind, value) } })
      .catch(() => undefined); // Nothing recorded for this key; fine.
  }

  private hashKey(kind: ThrottleKind, value: string): string {
    return createHmac('sha256', this.hmacKey)
      .update(`${kind}:${value.trim().toLowerCase()}`)
      .digest('hex');
  }
}
