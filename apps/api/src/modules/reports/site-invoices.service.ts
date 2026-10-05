/**
 * Building a client invoice: one site, one calendar month, one hourly rate.
 *
 * **This module owns no tables**, same as the rest of reports. The site
 * comes from the workforce module's own service — which is also what scopes
 * it to the caller's company and answers 404 for any other site — the hours
 * come from the attendance module's own service, and the worker names come
 * from the workforce module too. Nothing here reads another module's table
 * directly.
 */
import { Injectable } from '@nestjs/common';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { fromIsoDate, toAccraDate } from '../../common/dates.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AttendanceFactsService } from '../attendance/attendance-facts.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import { SitesService } from '../workforce/sites.service.js';
import { buildSiteInvoicePdf, type InvoiceLineForPdf, invoiceFileName } from './invoice-pdf.js';

export interface SiteInvoicePdf {
  bytes: Uint8Array;
  fileName: string;
}

@Injectable()
export class SiteInvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly employees: EmployeesService,
    private readonly attendance: AttendanceFactsService,
  ) {}

  async pdf(
    viewer: SignedInUser,
    siteId: string,
    month: string,
    hourlyRatePesewas: number,
  ): Promise<SiteInvoicePdf> {
    // Scopes to the caller's company and throws 404 for any other site —
    // the workforce module's own rule, read through its own service.
    const site = await this.sites.get(viewer, siteId);

    const [yearText, monthText] = month.split('-') as [string, string];
    const startsOn = fromIsoDate(`${yearText}-${monthText}-01`);
    const endsOn = new Date(Date.UTC(Number(yearText), Number(monthText), 0));

    const [company, workedMinutes] = await Promise.all([
      // No module owns a service for this one field yet (the Company table
      // has no "owning" module of its own); `detection.service.ts` already
      // reads this table directly for the same reason.
      this.prisma.company.findUniqueOrThrow({
        where: { id: viewer.companyId },
        select: { name: true },
      }),
      this.attendance.workedMinutesBySiteForMonth(viewer.companyId, siteId, { startsOn, endsOn }),
    ]);

    const refs = await this.employees.refsByIds(
      viewer.companyId,
      workedMinutes.map((row) => row.employeeId),
    );

    const lines: InvoiceLineForPdf[] = workedMinutes
      .map((row) => {
        const ref = refs.get(row.employeeId);
        if (!ref) {
          // A work segment's `employeeId` is a foreign key the database never
          // lets dangle, and an employee is never hard-deleted
          // (CONTRIBUTING.md), so every id this loop sees must resolve.
          throw new Error(`Employee ${row.employeeId} has a work segment but no employee record.`);
        }
        return {
          staffNumber: ref.staffNumber,
          fullName: ref.fullName,
          workedMinutes: row.workedMinutes,
        };
      })
      .sort((a, b) => a.staffNumber.localeCompare(b.staffNumber));

    const built = buildSiteInvoicePdf({
      issuerName: company.name,
      clientName: site.clientName,
      siteCode: site.code,
      siteName: site.name,
      month,
      invoiceNumber: `INV-${site.code}-${yearText}${monthText}`,
      issuedOn: toAccraDate(new Date()),
      hourlyRatePesewas,
      lines,
    });

    return { bytes: built.bytes, fileName: invoiceFileName(site.code, month) };
  }
}
