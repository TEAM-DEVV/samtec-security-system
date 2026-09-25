import { useQueryClient } from '@tanstack/react-query';
import { Check, Download, FileText, Send, Users, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { RunStatusBadge } from '@/components/payroll-badges';
import { TableEmptyRow, TableLoadingRows } from '@/components/table-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { $api } from '@/lib/api';
import { useCursorPages } from '@/lib/cursor-pages';
import { downloadFromApi } from '@/lib/download';
import { formatCedis, formatDate, formatDateTime, formatMinutes } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { exclusionReasonLabels, isTheMaker, mayDecide, runStatusDescriptions } from '@/lib/payroll';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 25;
const LINE_COLUMNS = 8;
/** The API insists on three characters, so the form does too. */
const SHORTEST_NOTE = 3;

/**
 * One payroll run: what it pays, who was left out, and the decision about it
 * (docs/plan/09-payroll-engine-ghana.md).
 *
 * The rule this page exists to make visible is that **the maker is never the
 * checker**. Whoever worked the run out, or sent it for approval, may never
 * approve or reject it. Rather than hiding the buttons and leaving somebody
 * wondering, the page shows why they are not there.
 */
export function PayrollRunPage() {
  const { runId = '' } = useParams<{ runId: string }>();
  usePageTitle('Payroll run');
  const session = useSession();
  const pages = useCursorPages();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [paidOn, setPaidOn] = useState('');

  const run = $api.useQuery('get', '/payroll/runs/{runId}', {
    params: { path: { runId } },
  });

  const lines = $api.useQuery('get', '/payroll/runs/{runId}/lines', {
    params: {
      path: { runId },
      query: {
        limit: PAGE_SIZE,
        ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
      },
    },
  });

  const statutory = $api.useQuery('get', '/payroll/runs/{runId}/statutory-summary', {
    params: { path: { runId } },
  });

  const afterDecision = () => {
    setNote('');
    setReason('');
    void queryClient.invalidateQueries();
  };

  const submit = $api.useMutation('post', '/payroll/runs/{runId}/submit', {
    onSuccess: afterDecision,
  });
  const approve = $api.useMutation('post', '/payroll/runs/{runId}/approve', {
    onSuccess: afterDecision,
  });
  const reject = $api.useMutation('post', '/payroll/runs/{runId}/reject', {
    onSuccess: afterDecision,
  });
  const markPaid = $api.useMutation('post', '/payroll/runs/{runId}/mark-paid', {
    onSuccess: afterDecision,
  });

  const decisionError = submit.error ?? approve.error ?? reject.error ?? markPaid.error;
  const deciding = submit.isPending || approve.isPending || reject.isPending || markPaid.isPending;

  const mayApprove = session !== null && roleAllowed(pageRoles.payrollApproval, session.user.role);
  const theirOwnWork =
    run.data !== undefined && session !== null && !mayDecide(run.data, session.user.id);
  const theyPreparedIt =
    run.data !== undefined && session !== null && isTheMaker(run.data, session.user.id);

  if (run.error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Payroll run" />
        <LoadErrorAlert
          title="This run could not be loaded"
          error={run.error}
          onRetry={() => void run.refetch()}
          retrying={run.isFetching}
        />
      </div>
    );
  }

  const totals = run.data?.totals;
  const summary = run.data?.summary;

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          run.data === undefined
            ? 'Payroll run'
            : `${formatDate(run.data.periodStartDate)} to ${formatDate(run.data.periodEndDate)}`
        }
        description={run.data === undefined ? undefined : runStatusDescriptions[run.data.status]}
      />

      {run.data !== undefined ? (
        <div className="flex flex-wrap items-center gap-3">
          <RunStatusBadge status={run.data.status} />
          <span className="text-muted-foreground text-sm">
            Worked out {formatDateTime(run.data.calculatedAt)}
          </span>
          {run.data.paidOn === null ? null : (
            <span className="text-muted-foreground text-sm">
              Paid {formatDate(run.data.paidOn)}
              {run.data.paymentReference === null ? '' : ` · ${run.data.paymentReference}`}
            </span>
          )}
        </div>
      ) : null}

      {decisionError ? (
        <LoadErrorAlert
          title="That decision could not be recorded"
          error={decisionError}
          onRetry={() => {
            submit.reset();
            approve.reset();
            reject.reset();
            markPaid.reset();
          }}
        />
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Net pay</CardDescription>
            <CardTitle className="text-2xl">
              {totals === undefined ? '—' : formatCedis(totals.totalNetPayPesewas)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            Gross {totals === undefined ? '—' : formatCedis(totals.totalGrossPesewas)}, less SSNIT,
            income tax and other deductions.
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>People paid</CardDescription>
            <CardTitle className="text-2xl">{summary?.employeeCount ?? '—'}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {summary === undefined
              ? '—'
              : `${summary.lineCount} line${summary.lineCount === 1 ? '' : 's'}, ${summary.adjustmentLineCount} of them corrections.`}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Owed to the state</CardDescription>
            <CardTitle className="text-2xl">
              {statutory.data === undefined
                ? '—'
                : formatCedis(statutory.data.totalSsnitPesewas + statutory.data.totalPayePesewas)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {statutory.data === undefined
              ? '—'
              : `SSNIT ${formatCedis(statutory.data.totalSsnitPesewas)} and income tax ${formatCedis(statutory.data.totalPayePesewas)}.`}
          </CardContent>
        </Card>
      </div>

      {summary !== undefined && summary.excluded.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Left out of this run</CardTitle>
            <CardDescription>
              Nobody is silently dropped. Each of these was skipped for a reason, and the reason is
              something to act on.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {summary.excluded.map((left) => (
                <li key={left.employee.id} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{left.employee.fullName}</span>
                  <span className="text-muted-foreground">{left.employee.staffNumber}</span>
                  <span aria-hidden="true">·</span>
                  <span>{exclusionReasonLabels[left.reason]}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {run.data !== undefined ? (
        <Card>
          <CardHeader>
            <CardTitle>What happens next</CardTitle>
            <CardDescription>
              The person who works a run out can never be the one who approves it. That is the whole
              point of a second pair of eyes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {run.data.status === 'DRAFT' ? (
              theyPreparedIt ? (
                <div className="space-y-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="submission-note">Note for the checker (optional)</Label>
                    <Textarea
                      id="submission-note"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Anything the approver should know before deciding."
                    />
                  </div>
                  <Button
                    disabled={deciding}
                    onClick={() =>
                      submit.mutate({
                        params: { path: { runId } },
                        body: note.trim().length >= SHORTEST_NOTE ? { note: note.trim() } : {},
                      })
                    }
                  >
                    <Send aria-hidden="true" className="size-4" />
                    Send for approval
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Only the person who worked this run out can send it for approval, so that one name
                  answers for the figures.
                </p>
              )
            ) : null}

            {run.data.status === 'PENDING_APPROVAL' ? (
              !mayApprove ? (
                <p className="text-muted-foreground text-sm">
                  An administrator decides about a run. A payroll officer prepares it.
                </p>
              ) : theirOwnWork ? (
                <p className="text-muted-foreground text-sm">
                  You worked on this run, so somebody else must approve or reject it.
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor="approval-note">Note (optional)</Label>
                    <Textarea
                      id="approval-note"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Why you are approving it, if it is worth recording."
                    />
                  </div>
                  <Button
                    disabled={deciding}
                    onClick={() =>
                      approve.mutate({
                        params: { path: { runId } },
                        body: note.trim().length >= SHORTEST_NOTE ? { note: note.trim() } : {},
                      })
                    }
                  >
                    <Check aria-hidden="true" className="size-4" />
                    Approve and make the payslips
                  </Button>

                  <div className="grid gap-1.5 border-t pt-4">
                    <Label htmlFor="rejection-reason">Reason for sending it back (required)</Label>
                    <Textarea
                      id="rejection-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="What is wrong, so whoever prepared it knows what to change."
                    />
                    <p className="text-muted-foreground text-sm">
                      A rejection is final. The answer to it is a fresh draft.
                    </p>
                    <Button
                      variant="destructive"
                      className="justify-self-start"
                      disabled={deciding || reason.trim().length < SHORTEST_NOTE}
                      onClick={() =>
                        reject.mutate({
                          params: { path: { runId } },
                          body: { reason: reason.trim() },
                        })
                      }
                    >
                      <X aria-hidden="true" className="size-4" />
                      Send it back
                    </Button>
                  </div>
                </div>
              )
            ) : null}

            {run.data.status === 'LOCKED' ? (
              mayApprove ? (
                <div className="space-y-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="paid-on">The day the money left</Label>
                    <input
                      id="paid-on"
                      type="date"
                      value={paidOn}
                      onChange={(event) => setPaidOn(event.target.value)}
                      className="h-9 w-48 rounded-md border border-input bg-background px-3 text-sm"
                    />
                    <p className="text-muted-foreground text-sm">
                      This records a payment that has already happened, so no second person is
                      needed and it works after the month is closed.
                    </p>
                  </div>
                  <Button
                    disabled={deciding || paidOn === ''}
                    onClick={() =>
                      markPaid.mutate({
                        params: { path: { runId } },
                        body: { paidOn },
                      })
                    }
                  >
                    <Wallet aria-hidden="true" className="size-4" />
                    Record the payment
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  An administrator records the payment once the money has gone.
                </p>
              )
            ) : null}

            {run.data.status === 'REJECTED' ? (
              <p className="text-sm">
                Sent back
                {run.data.rejectionReason === null ? '' : `: ${run.data.rejectionReason}`}
              </p>
            ) : null}

            {run.data.status === 'PAID' ? (
              <p className="text-muted-foreground text-sm">
                Nothing left to do. This run is settled and can never change.
              </p>
            ) : null}

            {run.data.status === 'LOCKED' || run.data.status === 'PAID' ? (
              <div className="border-t pt-4">
                <Button
                  variant="outline"
                  onClick={() =>
                    void downloadFromApi(
                      `/payroll/runs/${encodeURIComponent(runId)}/bank-export`,
                      `payroll-run-${runId}.csv`,
                    )
                  }
                >
                  <Download aria-hidden="true" className="size-4" />
                  Download the bank file
                </Button>
                <p className="text-muted-foreground mt-2 text-sm">
                  It carries account numbers, so downloading it is recorded against your name.
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Every line</CardTitle>
          <CardDescription>
            By staff number. Each figure is worked out from the figures beside it, so a payslip can
            be checked with a calculator.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {lines.error ? (
            <LoadErrorAlert
              title="The lines could not be loaded"
              error={lines.error}
              onRetry={() => void lines.refetch()}
              retrying={lines.isFetching}
            />
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full caption-bottom text-sm">
              <thead>
                <tr className="border-b">
                  <th className="h-10 px-2 text-left font-medium">Worker</th>
                  <th className="h-10 px-2 text-right font-medium">Days</th>
                  <th className="h-10 px-2 text-right font-medium">Basic</th>
                  <th className="h-10 px-2 text-right font-medium">Overtime</th>
                  <th className="h-10 px-2 text-right font-medium">Gross</th>
                  <th className="h-10 px-2 text-right font-medium">SSNIT</th>
                  <th className="h-10 px-2 text-right font-medium">Income tax</th>
                  <th className="h-10 px-2 text-right font-medium">Net pay</th>
                </tr>
              </thead>
              <tbody>
                {lines.isPending ? (
                  <TableLoadingRows colSpan={LINE_COLUMNS} label="Loading the lines…" />
                ) : null}
                {!lines.isPending && lines.data?.items.length === 0 ? (
                  <TableEmptyRow
                    colSpan={LINE_COLUMNS}
                    icon={Users}
                    title="This run pays nobody"
                    hint="Everybody was left out. The reasons are listed above."
                  />
                ) : null}
                {lines.data?.items.map((line) => (
                  <tr key={line.id} className="border-b">
                    <td className="p-2">
                      <span className="font-medium">{line.employee.fullName}</span>{' '}
                      <span className="text-muted-foreground">{line.employee.staffNumber}</span>
                      {line.adjustsLineId === null ? null : (
                        <span className="text-muted-foreground block text-xs">
                          A correction to an earlier month
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-right">
                      {line.daysEmployed}/{line.daysInPeriod}
                    </td>
                    <td className="p-2 text-right">{formatCedis(line.basicPesewas)}</td>
                    <td className="p-2 text-right">
                      {line.overtimeMinutes === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <>
                          {formatCedis(line.overtimePesewas)}
                          <span className="text-muted-foreground block text-xs">
                            {formatMinutes(line.overtimeMinutes)}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="p-2 text-right">{formatCedis(line.grossPesewas)}</td>
                    <td className="p-2 text-right">{formatCedis(line.ssnitEmployeePesewas)}</td>
                    <td className="p-2 text-right">{formatCedis(line.payePesewas)}</td>
                    <td className="p-2 text-right font-medium">
                      {formatCedis(line.netPayPesewas)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationNav
            pages={pages}
            nextCursor={lines.data?.nextCursor ?? null}
            busy={lines.isFetching}
          />
        </CardContent>
      </Card>

      {run.data?.status === 'LOCKED' || run.data?.status === 'PAID' ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <FileText aria-hidden="true" className="size-4" />A payslip was made for every line when
          this run was approved. Each worker can open their own from My payslips.
        </p>
      ) : null}
    </div>
  );
}
