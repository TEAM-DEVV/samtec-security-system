import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

/**
 * What the identity module will tell another module about its own tables.
 *
 * Ghost detection needs one thing from here: **who made an administrator
 * account** (docs/plan/06, "Two administrators"). Rule R11 asks whether a
 * two-person decision was really made by two people, and an administrator
 * account that somebody else created or confirmed is a link between them.
 *
 * Identifiers only. No name, no email, no password, nothing about anybody's
 * sign-in — a rule about who signed a form never needs to know who they are.
 */
@Injectable()
export class AccountFactsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * For each of these accounts, the administrators who put it there: the one
   * who asked for it and the one who confirmed it (rule R11).
   *
   * An account nobody asked for — made straight in the database by the seed
   * or the rescue script — has nobody, and an account that made itself
   * through the sole-administrator shortcut has nobody either, because
   * nobody else was there. Neither is a link between two people, so neither
   * appears.
   */
  async whoMadeTheseAdmins(
    companyId: string,
    userIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const accounts = await this.prisma.user.findMany({
      where: { companyId, id: { in: [...new Set(userIds)] }, role: 'ADMIN' },
      select: { id: true, adminRequestedByUserId: true, adminConfirmedByUserId: true },
    });
    const origins = new Map<string, string[]>();
    for (const account of accounts) {
      const madeBy = [account.adminRequestedByUserId, account.adminConfirmedByUserId].filter(
        (userId): userId is string => userId !== null && userId !== account.id,
      );
      if (madeBy.length > 0) {
        origins.set(account.id, [...new Set(madeBy)]);
      }
    }
    return origins;
  }
}
