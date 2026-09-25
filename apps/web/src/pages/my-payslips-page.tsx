import { Download, ReceiptText } from 'lucide-react';
import { useState } from 'react';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { RunStatusBadge } from '@/components/payroll-badges';
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
import { DownloadFailed, downloadFromApi } from '@/lib/download';
import { formatCedis, formatDate } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 12;
const COLUMNS = 6;

/**
 * Payslips: a worker's own pay, month by month
 * (docs/plan/09-payroll-engine-ghana.md).
 *
 * **This is the only payroll page a guard may open**, and they see their own
 * payslips and nobody else's. The API decides that, not this page: a guard's
 * list is scoped to them, and asking for somebody else's payslip answers "not
 * found" rather than "not allowed", so nobody can learn which payslips exist.
 *
 * An administrator or a payroll officer opening this page sees the whole
 * company's, which is what makes it useful for answering a worker's question at
 * the counter.
 */
export function MyPayslipsPage() {
  usePageTitle('My payslips');
  const session = useSession();
  const pages = useCursorPages();
  const [downloadError, setDownloadError] = useState<string>();

  const payslips = $api.useQuery('get', '/payroll/payslips', {
    params: {
      query: {
        limit: PAGE_SIZE,
        ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
      },
    },
  });

  const forOneWorker = session !== null && session.user.role === 'GUARD';

  const save = async (payslipId: string, staffNumber: string, periodEndDate: string) => {
    setDownloadError(undefined);
    try {
      await downloadFromApi(
        `/payroll/payslips/${encodeURIComponent(payslipId)}/pdf`,
        `payslip-${staffNumber}-${periodEndDate.slice(0, 7)}.pdf`,
      );
    } catch (error) {
      setDownloadError(
        error instanceof DownloadFailed ? error.message : 'The download failed. Please try again.',
      );
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={forOneWorker ? 'My payslips' : 'Payslips'}
        description={
          forOneWorker
            ? 'Your pay, month by month. Every figure is worked out from the figures printed beside it, so you can check a payslip with a calculator.'
            : 'Every payslip the company has issued. A payslip is made when a run is approved, and never changes afterwards.'
        }
      />

      {downloadError ? (
        <LoadErrorAlert
          title="The payslip could not be downloaded"
          error={new Error(downloadError)}
          onRetry={() => setDownloadError(undefined)}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Payslips</CardTitle>
          <CardDescription>
            Newest first. If a figure looks wrong, ask the payroll office and quote the month and
            your staff number.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {payslips.error ? (
            <LoadErrorAlert
              title="Your payslips could not be loaded"
              error={payslips.error}
              onRetry={() => void payslips.refetch()}
              retrying={payslips.isFetching}
            />
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                {forOneWorker ? null : <TableHead>Worker</TableHead>}
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Net pay</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Payslip</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payslips.isPending ? (
                <TableLoadingRows
                  colSpan={forOneWorker ? COLUMNS - 1 : COLUMNS}
                  label="Loading payslips…"
                  rows={3}
                />
              ) : null}
              {!payslips.isPending && payslips.data?.items.length === 0 ? (
                <TableEmptyRow
                  colSpan={forOneWorker ? COLUMNS - 1 : COLUMNS}
                  icon={ReceiptText}
                  title="No payslip yet"
                  hint={
                    forOneWorker
                      ? 'A payslip appears here once the month you worked has been approved.'
                      : 'A payslip is made when a payroll run is approved.'
                  }
                />
              ) : null}
              {payslips.data?.items.map((payslip) => (
                <TableRow key={payslip.id}>
                  <TableCell className="font-medium">
                    {formatDate(payslip.periodStartDate)} to {formatDate(payslip.periodEndDate)}
                    {payslip.adjustsLineId === null ? null : (
                      <span className="text-muted-foreground block text-xs">
                        A correction to that month
                      </span>
                    )}
                  </TableCell>
                  {forOneWorker ? null : (
                    <TableCell>
                      <span className="font-medium">{payslip.employee.fullName}</span>{' '}
                      <span className="text-muted-foreground">{payslip.employee.staffNumber}</span>
                    </TableCell>
                  )}
                  <TableCell className="text-right">{formatCedis(payslip.grossPesewas)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCedis(payslip.netPayPesewas)}
                  </TableCell>
                  <TableCell>
                    <RunStatusBadge status={payslip.runStatus} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void save(payslip.id, payslip.employee.staffNumber, payslip.periodEndDate)
                      }
                    >
                      <Download aria-hidden="true" className="size-4" />
                      Download
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationNav
            pages={pages}
            nextCursor={payslips.data?.nextCursor ?? null}
            busy={payslips.isFetching}
          />
        </CardContent>
      </Card>
    </div>
  );
}
