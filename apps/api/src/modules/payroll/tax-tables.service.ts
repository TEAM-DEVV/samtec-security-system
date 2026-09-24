/**
 * The statutory rates, as versions that are never edited.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md, decision 12. Rates change with
 * each national budget, so a change is a new version with its source recorded,
 * and a version a payroll run has used can never be altered afterwards. That
 * is what lets a locked run be re-checked years later and give the same
 * answer. There is deliberately no update and no delete endpoint.
 *
 * Only an ADMIN may read or write these: the rates decide what every worker in
 * the company is taxed.
 */
import { ConflictException, Injectable } from '@nestjs/common';
import type { TaxTable as ApiTaxTable, TaxTableList } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { fromIsoDate, toIsoDate } from '../../common/dates.js';
import { toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../identity/audit.service.js';
import type { CreateTaxTableBody, ListTaxTablesQuery } from './payroll.schemas.js';
import { pageBefore } from './payroll-cursor.js';
import { toApiTaxTable } from './payroll-mapping.js';

/** Bands always travel with their table, and always in order. */
const WITH_BANDS = { bands: { orderBy: { ordinal: 'asc' } } } as const;

@Injectable()
export class TaxTablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The company's rate versions, newest first.
   *
   * `effectiveOn` answers a different question from the others: not "which
   * versions are there" but "which one applied on this day", so it returns at
   * most one item — the latest version that had started by then.
   */
  async list(viewer: SignedInUser, query: ListTaxTablesQuery): Promise<TaxTableList> {
    if (query.effectiveOn !== undefined) {
      const row = await this.prisma.taxTable.findFirst({
        where: {
          companyId: viewer.companyId,
          effectiveFrom: { lte: fromIsoDate(query.effectiveOn) },
          ...(query.taxYear === undefined ? {} : { taxYear: query.taxYear }),
        },
        orderBy: { effectiveFrom: 'desc' },
        include: WITH_BANDS,
      });
      return { items: row === null ? [] : [toApiTaxTable(row)], nextCursor: null };
    }

    const after = pageBefore(query.cursor);
    const rows = await this.prisma.taxTable.findMany({
      where: {
        companyId: viewer.companyId,
        ...(query.taxYear === undefined ? {} : { taxYear: query.taxYear }),
        ...(after === undefined ? {} : { effectiveFrom: { lt: after } }),
      },
      orderBy: { effectiveFrom: 'desc' },
      take: query.limit + 1,
      include: WITH_BANDS,
    });

    const page = toPage(rows, query.limit, (row) => toIsoDate(row.effectiveFrom));
    return { items: page.pageRows.map(toApiTaxTable), nextCursor: page.nextCursor };
  }

  /**
   * Adds a version. The bands are written with it in one transaction, because
   * a table without its open top band would tax nobody's highest slice — the
   * database refuses the half-written state outright, and this keeps it from
   * ever arising.
   */
  async create(viewer: SignedInUser, body: CreateTaxTableBody): Promise<ApiTaxTable> {
    const effectiveFrom = fromIsoDate(body.effectiveFrom);

    const created = await this.prisma.$transaction(async (tx) => {
      const clash = await tx.taxTable.findFirst({
        where: { companyId: viewer.companyId, effectiveFrom },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException('Another version of the rates already starts on that day.');
      }

      const table = await tx.taxTable.create({
        data: {
          companyId: viewer.companyId,
          taxYear: body.taxYear,
          effectiveFrom,
          effectiveTo:
            body.effectiveTo === null || body.effectiveTo === undefined
              ? null
              : fromIsoDate(body.effectiveTo),
          ssnitEmployeeBasisPoints: body.ssnitEmployeeBasisPoints,
          ssnitEmployerBasisPoints: body.ssnitEmployerBasisPoints,
          ssnitTier1BasisPoints: body.ssnitTier1BasisPoints,
          ssnitTier2BasisPoints: body.ssnitTier2BasisPoints,
          sourceName: body.sourceName,
          sourceUrl: body.sourceUrl,
          sourceCheckedOn: fromIsoDate(body.sourceCheckedOn),
          createdByUserId: viewer.userId,
          bands: {
            create: body.bands.map((band) => ({
              companyId: viewer.companyId,
              ordinal: band.ordinal,
              widthPesewas: band.widthPesewas,
              rateBasisPoints: band.rateBasisPoints,
            })),
          },
        },
        include: WITH_BANDS,
      });

      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'payroll.tax_table_created',
          entityType: 'tax_table',
          entityId: table.id,
          detail: {
            taxYear: table.taxYear,
            effectiveFrom: toIsoDate(table.effectiveFrom),
            bandCount: table.bands.length,
          },
        },
        tx,
      );
      return table;
    });

    return toApiTaxTable(created);
  }

  // ---------------------------------------------------------------------------
}
