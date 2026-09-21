import { Injectable } from '@nestjs/common';
import type { PasswordSetup } from '@samtec/contracts';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from './audit.service.js';
import { TokensService } from './tokens.service.js';

/** A one-time password link lasts 72 hours: long enough to hand over, short enough to expire. */
export const PASSWORD_SETUP_HOURS = 72;

/**
 * The account building blocks that sign-in, user management and the
 * workforce module share, so each rule lives in exactly one place. Only the
 * identity module writes the account tables; other modules call these
 * methods instead (the module rule in CLAUDE.md).
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Ends every way into the account: all refresh sessions are revoked and
   * every unfinished sign-in step or password link is deleted. Its current
   * access token then fails on the next request, because the token guard
   * checks the account every time.
   */
  async endAllAccess(userId: string, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await tx.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.authChallenge.deleteMany({ where: { userId } });
  }

  /**
   * Issues a one-time password link for the account, replacing any earlier
   * one. Only its SHA-256 hash is stored; the token itself exists only in the
   * response that hands it to the administrator.
   */
  async issuePasswordSetup(
    userId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<PasswordSetup> {
    await tx.authChallenge.deleteMany({ where: { userId, purpose: 'SET_PASSWORD' } });
    const token = this.tokens.newOpaqueToken();
    const expiresAt = new Date(Date.now() + PASSWORD_SETUP_HOURS * 3_600_000);
    await tx.authChallenge.create({
      data: {
        userId,
        purpose: 'SET_PASSWORD',
        tokenHash: this.tokens.hashToken(token),
        expiresAt,
      },
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Called by the workforce module when an employee is terminated, inside its
   * transaction: the leaver's sign-in account (if any) is switched off at
   * once. Only SUPERVISOR and GUARD accounts are ever linked to an employee
   * (a database CHECK), so this can never switch off an office account.
   */
  async deactivateForLeaver(
    tx: Prisma.TransactionClient,
    leaver: { companyId: string; employeeId: string; actorUserId: string },
  ): Promise<void> {
    const account = await tx.user.findUnique({ where: { employeeId: leaver.employeeId } });
    if (!account?.isActive || account.companyId !== leaver.companyId) {
      return;
    }
    await tx.user.update({ where: { id: account.id }, data: { isActive: false } });
    await this.endAllAccess(account.id, tx);
    await this.audit.record(
      {
        companyId: leaver.companyId,
        actorUserId: leaver.actorUserId,
        action: 'user.deactivated',
        entityType: 'user',
        entityId: account.id,
        detail: { reason: 'EMPLOYEE_TERMINATED', employeeId: leaver.employeeId },
      },
      tx,
    );
  }
}
