import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import { AuditService } from '../identity/audit.service.js';
import {
  idSchema,
  invoiceMonthSchema,
  type SiteInvoiceQuery,
  siteInvoiceQuerySchema,
} from './reports.schemas.js';
import { SiteInvoicesService } from './site-invoices.service.js';

/**
 * `/api/v1/sites/{siteId}/invoices/{month}.pdf`. Contract:
 * `downloadSiteInvoicePdf`.
 *
 * Its own file and its own `@Controller()`, separate from
 * `workforce/sites.controller.ts`, so the two never touch the same file.
 *
 * Billing a client is ADMIN and HR_PAYROLL work; a SUPERVISOR never sees it,
 * even for their own site, the same as every other payroll-shaped figure.
 */
@Controller()
@Roles('ADMIN', 'HR_PAYROLL')
export class SiteInvoicesController {
  constructor(
    private readonly invoices: SiteInvoicesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The invoice is built fresh on every request, never stored, so
   * downloading it twice is harmless. The download itself is audited: it
   * leaves the building, to a client. The entry names the site and the
   * month and nothing from the invoice itself — no rate, no amount, no
   * worker.
   */
  @Get('sites/:siteId/invoices/:month.pdf')
  async pdf(
    @Caller() caller: SignedInUser,
    @Param('siteId', { schema: idSchema }) siteId: string,
    @Param('month', { schema: invoiceMonthSchema }) month: string,
    @Query({ schema: siteInvoiceQuerySchema }) query: SiteInvoiceQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.invoices.pdf(caller, siteId, month, query.hourlyRatePesewas);
    await this.audit.record({
      companyId: caller.companyId,
      actorUserId: caller.userId,
      action: 'site.invoice_downloaded',
      entityType: 'site',
      entityId: siteId,
      detail: { month },
    });
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(file.bytes), {
      type: 'application/pdf',
      disposition: `attachment; filename="${file.fileName}"`,
    });
  }
}
