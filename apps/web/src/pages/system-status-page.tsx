import type { HealthResponse } from '@samtec/contracts';
import { cn } from 'cn';
import { CircleCheck, CircleX, RefreshCw } from 'lucide-react';
import { DetailRow } from '@/components/detail-row';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { env } from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError, isProblemDetails } from '@/lib/problem';

/** A 503 answer still carries a health report, so a report can arrive as data or as the error. */
function isHealthReport(value: unknown): value is HealthResponse {
  return typeof value === 'object' && value !== null && 'status' in value && 'checks' in value;
}

/**
 * Shows whether the dashboard can reach the API, and whether the API can reach
 * its database. This page is the Phase 0 exit demo, and the simplest example of
 * loading data from the API.
 */
export function SystemStatusPage() {
  usePageTitle('System status');
  // No automatic retry here: a failed check should show straight away.
  const health = $api.useQuery('get', '/health', {}, { retry: false });

  // Look only at the latest check. When a new check fails, React Query keeps
  // the older successful report in `data`, and it must not be shown as current.
  const latest: unknown = health.isError ? health.error : health.data;
  const report = isHealthReport(latest) ? latest : undefined;
  const apiAnsweredWithError = report === undefined && isProblemDetails(latest);
  const apiUnreachable = health.isError && report === undefined && !apiAnsweredWithError;

  function checkAgain() {
    // Ignore extra clicks while a check is running. The button stays enabled,
    // so keyboard users never lose their place.
    if (!health.isFetching) {
      void health.refetch();
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow="System"
        title="System status"
        description="Checks that the dashboard can reach the SAMTEC API, and that the API can reach its database."
        actions={
          <Button variant="outline" size="sm" onClick={checkAgain}>
            <RefreshCw aria-hidden="true" className={cn(health.isFetching && 'animate-spin')} />
            Check again
          </Button>
        }
      />

      <p role="status" className="sr-only">
        {health.isFetching ? 'Checking the API…' : ''}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatusCard
          title="API"
          description={env.useMocks ? 'Mock API running in this browser' : 'SAMTEC REST API'}
          loading={health.isPending}
          ok={report !== undefined}
          okLabel="Reachable"
          failLabel={apiAnsweredWithError ? 'Answered with an error' : 'Not reachable'}
        />
        <StatusCard
          title="Database"
          description={env.useMocks ? 'Simulated by the mock API' : 'PostgreSQL'}
          loading={health.isPending}
          ok={report?.checks.database === 'up'}
          okLabel={env.useMocks ? 'Simulated' : 'Connected'}
          failLabel={report ? 'Down' : 'Unknown'}
        />
      </div>

      {apiUnreachable && (
        <Alert variant="destructive">
          <AlertTitle>The dashboard cannot reach the API</AlertTitle>
          <AlertDescription>
            <p>Check these, then press Check again:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                The API is running (<code>pnpm dev:api</code>).
              </li>
              <li>
                The dashboard calls the right address: <code>{env.apiBaseUrl}</code>
              </li>
              <li>
                The API's <code>CORS_ORIGINS</code> setting includes this dashboard's address,{' '}
                <code>{window.location.origin}</code>.
              </li>
            </ul>
            <p>
              To work with pretend data instead, run <code>pnpm dev:web</code>.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {apiAnsweredWithError && <ApiErrorAlert error={latest} />}

      {report && (
        <Card>
          <CardHeader>
            <CardTitle className="font-heading text-lg">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-2 text-sm">
              <DetailRow term="API address">{env.apiBaseUrl}</DetailRow>
              <DetailRow term="Server time (Ghana)">
                <span className="tabular-nums">{formatDateTime(report.time)}</span>
              </DetailRow>
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface StatusCardProps {
  title: string;
  description: string;
  loading: boolean;
  ok: boolean;
  okLabel: string;
  failLabel: string;
}

function StatusCard({ title, description, loading, ok, okLabel, failLabel }: StatusCardProps) {
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <Card className="rounded-2xl motion-safe:animate-rise-soft">
      <CardHeader>
        <CardTitle className="font-heading text-lg">{title}</CardTitle>
        <CardDescription className="truncate">{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-6 w-32" />
        ) : (
          <p
            className={cn(
              'flex items-center gap-2 font-medium',
              ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive',
            )}
          >
            <span aria-hidden="true" className="relative flex size-5 items-center justify-center">
              {ok && (
                <span className="absolute size-2.5 rounded-full bg-emerald-500 motion-safe:animate-ping-soft" />
              )}
              <Icon className="relative size-5" />
            </span>
            {ok ? okLabel : failLabel}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The API answered, but with an error instead of a health report (for example a 500). */
function ApiErrorAlert({ error }: { error: unknown }) {
  const { message, traceId } = describeApiError(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>The API answered with an error</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {traceId && <p className="font-mono text-xs">Trace ID: {traceId}</p>}
      </AlertDescription>
    </Alert>
  );
}
