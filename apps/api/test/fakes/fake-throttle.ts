import { RateLimitException } from '../../src/common/rate-limit.exception.js';
import type {
  SignInThrottleService,
  ThrottleKind,
} from '../../src/modules/identity/sign-in-throttle.service.js';

/**
 * An in-memory stand-in for `SignInThrottleService` with the same behaviour:
 * five failures lock a key for 15 minutes. The real service does its counting
 * in one atomic SQL statement, so its real behaviour (including parallel
 * attempts) is tested against a real database in `test/db.e2e-spec.ts`.
 */
export class FakeThrottle {
  failures = new Map<string, number>();
  lockedUntil = new Map<string, number>();

  async assertNotLocked(kind: ThrottleKind, value: string): Promise<void> {
    const until = this.lockedUntil.get(`${kind}:${value}`);
    if (until !== undefined && until > Date.now()) {
      throw new RateLimitException('Too many attempts. Try again in 900 seconds.', 900);
    }
  }

  async recordFailure(kind: ThrottleKind, value: string): Promise<boolean> {
    const key = `${kind}:${value}`;
    const count = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, count);
    if (count >= 5) {
      this.lockedUntil.set(key, Date.now() + 15 * 60_000);
      return true;
    }
    return false;
  }

  async recordSuccess(kind: ThrottleKind, value: string): Promise<void> {
    const key = `${kind}:${value}`;
    this.failures.delete(key);
    this.lockedUntil.delete(key);
  }

  asService(): SignInThrottleService {
    return this as unknown as SignInThrottleService;
  }
}
