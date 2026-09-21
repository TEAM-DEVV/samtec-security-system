import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/database/prisma.service.js';
import type { AuthChallenge, User, UserSession } from '../../src/generated/prisma/client.js';

/**
 * A pretend database for the identity unit tests: plain objects in arrays,
 * with just the Prisma methods `AuthService` calls. Because services receive
 * the database through their constructors, tests can hand them this instead
 * of a real PostgreSQL connection, and stay fast.
 *
 * The e2e tests in `test/db.e2e-spec.ts` run the same flows against a real
 * database, so this fake cannot drift silently. (`SignInThrottleService`
 * writes atomic SQL, so it is only tested against the real database; the
 * unit tests pair `AuthService` with `FakeThrottle` below instead.)
 */
export class FakeIdentityDb {
  users: User[] = [];
  sessions: UserSession[] = [];
  challenges: AuthChallenge[] = [];
  auditEntries: Array<{ action: string; entityId: string | null }> = [];
  /** The same audit rows with who did it and the detail, for tests that check audit hygiene. */
  auditRows: Array<{ action: string; actorUserId: string | null; detail: unknown }> = [];

  /** Adds a user with sensible defaults; override what a test cares about. */
  addUser(overrides: Partial<User> & Pick<User, 'email' | 'passwordHash' | 'role'>): User {
    const user: User = {
      id: randomUUID(),
      companyId: '01927c3e-0000-7000-8000-000000000001',
      fullName: 'Test Person',
      isActive: true,
      employeeId: null,
      twoFactorSecretEncrypted: null,
      twoFactorEnabledAt: null,
      twoFactorLastUsedStep: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.users.push(user);
    return user;
  }

  /** The object the services see. Only the methods they actually call exist. */
  asPrisma(): PrismaService {
    const prisma = {
      user: {
        findFirst: async ({ where }: { where: { email: string } }) =>
          this.users.find((user) => user.email === where.email) ?? null,
        findUnique: async ({ where }: { where: { id: string } }) =>
          this.users.find((user) => user.id === where.id) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Partial<User> }) => {
          const user = this.users.find((candidate) => candidate.id === where.id);
          if (!user) throw new Error('No such user');
          Object.assign(user, data, { updatedAt: new Date() });
          return user;
        },
      },
      userSession: {
        create: async ({
          data,
        }: {
          data: Omit<UserSession, 'id' | 'createdAt' | 'revokedAt' | 'replacedById'>;
        }) => {
          const session: UserSession = {
            id: randomUUID(),
            createdAt: new Date(),
            revokedAt: null,
            replacedById: null,
            ...data,
          };
          this.sessions.push(session);
          return session;
        },
        findUnique: async ({ where }: { where: { tokenHash: string } }) => {
          const session = this.sessions.find(
            (candidate) => candidate.tokenHash === where.tokenHash,
          );
          if (!session) return null;
          const user = this.users.find((candidate) => candidate.id === session.userId);
          return { ...session, user };
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<UserSession> }) => {
          const session = this.sessions.find((candidate) => candidate.id === where.id);
          if (!session) throw new Error('No such session');
          Object.assign(session, data);
          return session;
        },
        // Matches on whichever of id / userId / revokedAt the caller sent,
        // and reports how many rows changed — like the real updateMany.
        updateMany: async ({
          where,
          data,
        }: {
          where: { id?: string; userId?: string; revokedAt?: null };
          data: Partial<UserSession>;
        }) => {
          let count = 0;
          for (const session of this.sessions) {
            const matches =
              (where.id === undefined || session.id === where.id) &&
              (where.userId === undefined || session.userId === where.userId) &&
              (!('revokedAt' in where) || session.revokedAt === where.revokedAt);
            if (matches) {
              Object.assign(session, data);
              count += 1;
            }
          }
          return { count };
        },
      },
      authChallenge: {
        create: async ({
          data,
        }: {
          data: Omit<
            AuthChallenge,
            'id' | 'createdAt' | 'failedAttempts' | 'pendingSecretEncrypted'
          >;
        }) => {
          const challenge: AuthChallenge = {
            id: randomUUID(),
            createdAt: new Date(),
            failedAttempts: 0,
            pendingSecretEncrypted: null,
            ...data,
          };
          this.challenges.push(challenge);
          return challenge;
        },
        findUnique: async ({ where }: { where: { tokenHash: string } }) => {
          const challenge = this.challenges.find(
            (candidate) => candidate.tokenHash === where.tokenHash,
          );
          if (!challenge) return null;
          const user = this.users.find((candidate) => candidate.id === challenge.userId);
          return { ...challenge, user };
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Omit<Partial<AuthChallenge>, 'failedAttempts'> & {
            failedAttempts?: number | { increment: number };
          };
        }) => {
          const challenge = this.challenges.find((candidate) => candidate.id === where.id);
          if (!challenge) throw new Error('No such challenge');
          const { failedAttempts, ...rest } = data;
          Object.assign(challenge, rest);
          if (typeof failedAttempts === 'number') {
            challenge.failedAttempts = failedAttempts;
          } else if (failedAttempts !== undefined) {
            challenge.failedAttempts += failedAttempts.increment;
          }
          return challenge;
        },
        delete: async ({ where }: { where: { id: string } }) => {
          this.challenges = this.challenges.filter((candidate) => candidate.id !== where.id);
        },
        // Matches on whichever of id / userId / purpose the caller sent, and
        // reports how many rows went — like the real deleteMany.
        deleteMany: async ({
          where,
        }: {
          where: { id?: string; userId?: string; purpose?: string };
        }) => {
          const matches = (candidate: AuthChallenge) =>
            (where.id === undefined || candidate.id === where.id) &&
            (where.userId === undefined || candidate.userId === where.userId) &&
            (where.purpose === undefined || candidate.purpose === where.purpose);
          const before = this.challenges.length;
          this.challenges = this.challenges.filter((candidate) => !matches(candidate));
          return { count: before - this.challenges.length };
        },
      },
      auditLog: {
        create: async ({
          data,
        }: {
          data: { action: string; entityId?: string; actorUserId: string | null; detail?: unknown };
        }) => {
          this.auditEntries.push({ action: data.action, entityId: data.entityId ?? null });
          this.auditRows.push({
            action: data.action,
            actorUserId: data.actorUserId,
            detail: data.detail ?? null,
          });
        },
      },
    } as unknown as PrismaService;
    // A transaction here simply runs the steps against the same arrays.
    Object.assign(prisma, {
      $transaction: async <T>(steps: (tx: PrismaService) => Promise<T>) => steps(prisma),
    });
    return prisma;
  }
}
