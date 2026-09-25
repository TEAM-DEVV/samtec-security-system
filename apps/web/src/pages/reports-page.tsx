import { CalendarRange, Download, TrendingUp, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { $api } from '@/lib/api';
import { DownloadFailed, downloadFromApi } from '@/lib/download';
import { formatCedis, formatDate, todayInGhana } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { monthName } from '@/lib/payroll';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

/** A month back from today, which is the range a manager asks for most. */
function aMonthAgo(): string {
  const at = new Date(Date.now() - 30 * 86_400_000);
  return at.toISOString().slice(0, 10);
}

/**
 * Reports (Phase 6): the figures a manager reads at a glance, and the files they
 * take away.
 *
 * Every figure comes from the same tables the screens read, so a report can
 * never disagree with the page beside it.
 *
 * A supervisor sees the attendance figures and the attendance download, because
 * they already read the attendance board. The payroll cost is payroll, so they
 * do not see it — here or anywhere.
 */
export function ReportsPage() {
  usePageTitle('Reports');
  const session = useSession();
  const mayReadPayroll = session !== null && roleAllowed(pageRoles.payroll, session.user.role);
  const [from, setFrom] = useState(aMonthAgo);
  const [to, setTo] = useState(todayInGhana);
  const [downloadError, setDownloadError] = useState<string>();

  const overview = $api.useQuery('get', '/reports/overview');

  const save = async (path: string, fileName: string) => {
    setDownloadError(undefined);
    try {
      await downloadFromApi(path, fileName);
    } catch (error) {
      setDownloadError(
        error instanceof DownloadFailed ? error.message : 'The download failed. Please try again.',
      );
    }
  };

  const absence = overview.data?.absence;
  const present = overview.data?.present;
  const cost = overview.data?.payrollCost ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Who is at work, how much absence there is, and what payroll is costing. Every figure is counted from the same records the other pages show."
      />

      {overview.error ? (
        <LoadErrorAlert
          title="The figures could not be loaded"
          error={overview.error}
          onRetry={() => void overview.refetch()}
          retrying={overview.isFetching}
        />
      ) : null}

      {downloadError ? (
        <LoadErrorAlert
          title="The report could not be downloaded"
          error={new Error(downloadError)}
          onRetry={() => setDownloadError(undefined)}
        />
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <UserCheck aria-hidden="true" className="size-4" />
              At work right now
            </CardDescription>
            <CardTitle className="text-3xl">
              {present === undefined ? '—' : present.onShift}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {present === undefined
              ? 'Loading…'
              : `of ${present.activeEmployees} active worker${present.activeEmployees === 1 ? '' : 's'}. Counted from shifts that have begun and not ended.`}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <CalendarRange aria-hidden="true" className="size-4" />
              Absence, last 30 days
            </CardDescription>
            <CardTitle className="text-3xl">
              {absence === undefined
                ? '—'
                : absence.basisPoints === null
                  ? 'Nothing to compare'
                  : `${(absence.basisPoints / 100).toFixed(1)}%`}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {absence === undefined ? (
              'Loading…'
            ) : absence.basisPoints === null ? (
              // A rate of zero here would read as "nobody was ever absent",
              // which is a very different claim from "nothing was scheduled".
              <>No shift patterns are posted, so there is no expectation to measure against.</>
            ) : (
              <>
                {Math.round(absence.workedMinutes / 60).toLocaleString()} hours worked of{' '}
                {Math.round(absence.scheduledMinutes / 60).toLocaleString()} scheduled, from{' '}
                {formatDate(absence.fromDate)} to {formatDate(absence.toDate)}.
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {mayReadPayroll ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp aria-hidden="true" className="size-4" />
              What payroll has cost
            </CardTitle>
            <CardDescription>
              Newest month first. Only an approved run counts: a draft is a proposal, not a cost.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">People</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Paid to workers</TableHead>
                  <TableHead className="text-right">Owed to the state</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cost.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground py-6 text-center">
                      No month has an approved run yet, so there is nothing to cost.
                    </TableCell>
                  </TableRow>
                ) : null}
                {cost.map((month) => (
                  <TableRow key={month.runId}>
                    <TableCell className="font-medium">
                      {monthName(month.year, month.month)}
                    </TableCell>
                    <TableCell className="text-right">{month.employeeCount}</TableCell>
                    <TableCell className="text-right">{formatCedis(month.grossPesewas)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCedis(month.netPayPesewas)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCedis(month.statutoryPesewas)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Button
              variant="outline"
              onClick={() => void save('/reports/payroll-cost.csv', 'payroll-cost.csv')}
            >
              <Download aria-hidden="true" className="size-4" />
              Download as a spreadsheet
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Attendance, as a spreadsheet</CardTitle>
          <CardDescription>
            One row per confirmed shift: who, when, where, how long, and how they clocked in. At
            most 92 days at a time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="report-from">From</Label>
              <input
                id="report-from"
                type="date"
                value={from}
                max={to}
                onChange={(event) => setFrom(event.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="report-to">To</Label>
              <input
                id="report-to"
                type="date"
                value={to}
                min={from}
                onChange={(event) => setTo(event.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <Button
              disabled={from === '' || to === '' || to < from}
              onClick={() =>
                void save(
                  `/reports/attendance.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
                  `attendance-${from}-to-${to}.csv`,
                )
              }
            >
              <Download aria-hidden="true" className="size-4" />
              Download
            </Button>
          </div>
          {to < from ? (
            <p className="text-destructive text-sm">The last day cannot be before the first.</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
