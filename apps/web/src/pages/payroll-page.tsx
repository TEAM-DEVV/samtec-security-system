import type { PayrollPeriod, PayrollRunStatus } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Calculator, CalendarPlus, Lock, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { PeriodStatusBadge, RunStatusBadge } from '@/components/payroll-badges';
import { SelectField } from '@/components/select-field';
import { TableEmptyRow, TableLoadingRows } from '@/components/table-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { $api } from '@/lib/api';
import { useCursorPages } from '@/lib/cursor-pages';
import { formatCedis, formatDate } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { isRunStatus, monthName, RUN_STATUSES, runStatusLabels } from '@/lib/payroll';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 20;
const MONTH_COLUMNS = 5;
const RUN_COLUMNS = 6;

/**
 * Payroll: the months, and every run worked out for them
 * (docs/plan/09-payroll-engine-ghana.md).
 *
 * A month is opened, runs are worked out inside it, one of them is approved by a
 * second person, and then the month is closed. All four happen here, so nobody
 * has to hold the shape of it in their head.
 *
 * Every button this page shows is one the API would accept from this person. The
 * decisions that turn on *who prepared the run* live on the run's own page,
 * because that is where the names are.
 */
export function PayrollPage() {
  usePageTitle('Payroll');
  const session = useSession();
  const mayChange = session !== null && roleAllowed(pageRoles.payrollChanges, session.user.role);
  const [status, setStatus] = useState<PayrollRunStatus>();
  const pages = useCursorPages();
  const queryClient = useQueryClient();

  const periods = $api.useQuery('get', '/payroll/periods', {
    params: { query: { limit: PAGE_SIZE } },
  });

  const runs = $api.useQuery('get', '/payroll/runs', {
    params: {
      query: {
        limit: PAGE_SIZE,
        ...(status === undefined ? {} : { status }),
        ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
      },
    },
  });

  const refreshEverything = () => {
    void queryClient.invalidateQueries();
  };

  const openMonth = $api.useMutation('post', '/payroll/periods', {
    onSuccess: refreshEverything,
  });
  const calculate = $api.useMutation('post', '/payroll/runs', { onSuccess: refreshEverything });
  const closeMonth = $api.useMutation('post', '/payroll/periods/{periodId}/close', {
    onSuccess: refreshEverything,
  });

  const nextMonth = nextMonthToOpen(periods.data?.items ?? []);
  /** Whatever the person just tried, so one place explains what went wrong. */
  const actionError = openMonth.error ?? calculate.error ?? closeMonth.error;
  const acting = openMonth.isPending || calculate.isPending || closeMonth.isPending;
  const clearActionError = () => {
    openMonth.reset();
    calculate.reset();
    closeMonth.reset();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payroll"
        description="Each month is opened, worked out, approved by a second person, and then closed."
      />

      {actionError ? (
        <LoadErrorAlert
          title="That could not be done"
          error={actionError}
          onRetry={clearActionError}
        />
      ) : null}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Months</CardTitle>
            <CardDescription>
              A month is exactly one calendar month. Closing it is final, and no new run can be
              worked out for it afterwards.
            </CardDescription>
          </div>
          {mayChange ? (
            <Button onClick={() => openMonth.mutate({ body: nextMonth })} disabled={acting}>
              <CalendarPlus aria-hidden="true" className="size-4" />
              Open {monthName(nextMonth.year, nextMonth.month)}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3">
          {periods.error ? (
            <LoadErrorAlert
              title="The months could not be loaded"
              error={periods.error}
              onRetry={() => void periods.refetch()}
              retrying={periods.isFetching}
            />
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Approved run</TableHead>
                <TableHead className="text-right">What you can do</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {periods.isPending ? (
                <TableLoadingRows
                  colSpan={MONTH_COLUMNS}
                  label="Loading payroll months…"
                  rows={3}
                />
              ) : null}
              {!periods.isPending && periods.data?.items.length === 0 ? (
                <TableEmptyRow
                  colSpan={MONTH_COLUMNS}
                  icon={Wallet}
                  title="No payroll month yet"
                  hint="Open one, and you can work out a run for it."
                />
              ) : null}
              {periods.data?.items.map((period) => (
                <TableRow key={period.id}>
                  <TableCell className="font-medium">
                    {monthName(period.year, period.month)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(period.startDate)} to {formatDate(period.endDate)}
                  </TableCell>
                  <TableCell>
                    <PeriodStatusBadge status={period.status} />
                  </TableCell>
                  <TableCell>
                    {period.lockedRunId === null ? (
                      <span className="text-muted-foreground">None yet</span>
                    ) : (
                      <Link className="underline" to={routes.payrollRun(period.lockedRunId)}>
                        Open it
                      </Link>
                    )}
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    {mayChange && period.status === 'OPEN' ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => calculate.mutate({ body: { periodId: period.id } })}
                          disabled={acting}
                        >
                          <Calculator aria-hidden="true" className="size-4" />
                          Work out a run
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            closeMonth.mutate({ params: { path: { periodId: period.id } } })
                          }
                          disabled={acting}
                        >
                          <Lock aria-hidden="true" className="size-4" />
                          Close the month
                        </Button>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Nothing left to do</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Runs</CardTitle>
            <CardDescription>
              Newest first. Working a month out again makes a new draft, and never changes the one
              before it.
            </CardDescription>
          </div>
          <SelectField
            id="run-status"
            label="State"
            value={status ?? ''}
            onChange={(value) => {
              setStatus(isRunStatus(value) ? value : undefined);
              pages.reset();
            }}
          >
            <option value="">Any state</option>
            {RUN_STATUSES.map((one) => (
              <option key={one} value={one}>
                {runStatusLabels[one]}
              </option>
            ))}
          </SelectField>
        </CardHeader>
        <CardContent className="space-y-3">
          {runs.error ? (
            <LoadErrorAlert
              title="The runs could not be loaded"
              error={runs.error}
              onRetry={() => void runs.refetch()}
              retrying={runs.isFetching}
            />
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">People</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Net pay</TableHead>
                <TableHead className="text-right">Worked out</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.isPending ? (
                <TableLoadingRows colSpan={RUN_COLUMNS} label="Loading payroll runs…" />
              ) : null}
              {!runs.isPending && runs.data?.items.length === 0 ? (
                <TableEmptyRow
                  colSpan={RUN_COLUMNS}
                  icon={Calculator}
                  title={
                    status === undefined
                      ? 'No run has been worked out yet'
                      : `No run is ${runStatusLabels[status].toLowerCase()}`
                  }
                  hint={
                    status === undefined
                      ? 'Open a month above, then work out a run for it.'
                      : 'Choose another state to see more.'
                  }
                />
              ) : null}
              {runs.data?.items.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="font-medium">
                    <Link className="underline" to={routes.payrollRun(run.id)}>
                      {formatDate(run.periodStartDate)} to {formatDate(run.periodEndDate)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <RunStatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="text-right">{run.summary.employeeCount}</TableCell>
                  <TableCell className="text-right">
                    {formatCedis(run.totals.totalGrossPesewas)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCedis(run.totals.totalNetPayPesewas)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatDate(run.calculatedAt.slice(0, 10))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationNav
            pages={pages}
            nextCursor={runs.data?.nextCursor ?? null}
            busy={runs.isFetching}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The month after the newest one that already has a period, or this month when
 * there are none at all.
 *
 * Offering one specific month rather than a form is deliberate: the next payroll
 * month is always the next one, and a free choice of year and month is a way to
 * open 2019 by accident — a period that can never be deleted.
 */
export function nextMonthToOpen(
  periods: readonly Pick<PayrollPeriod, 'year' | 'month'>[],
  now: Date = new Date(),
): { year: number; month: number } {
  if (periods.length === 0) {
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  }
  // Counting months from year zero makes "the next one" plain addition, and
  // December rolls into January of the year after with no special case.
  const monthsSinceYearZero = (period: { year: number; month: number }) =>
    period.year * 12 + (period.month - 1);
  const next = Math.max(...periods.map(monthsSinceYearZero)) + 1;
  return { year: Math.floor(next / 12), month: (next % 12) + 1 };
}
