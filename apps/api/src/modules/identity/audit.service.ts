import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

/** One entry for the audit log. `detail` holds IDs and field names, never personal data. */
export interface AuditEntry {
  companyId: string;
  /** Who did it, or null when no user was signed in (for example a lockout). */
  actorUserId: string | null;
  /** A short dotted name, for example `auth.two_factor_enabled`. */
  action: string;
  /** What kind of record was affected, for example `user` or `employee`. */
  entityType: string;
  entityId?: string;
  detail?: Record<string, string | number | boolean | null>;
}

/**
 * Writes the audit log: who changed what, and when. The table is append-only
 * (a database trigger rejects every change and delete), so the log is
 * evidence, not just information.
 *
 * Every module records its important changes through this service; only the
 * identity module touches the table itself.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        companyId: entry.companyId,
        actorUserId: entry.actorUserId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        detail: entry.detail,
      },
    });
  }
}
