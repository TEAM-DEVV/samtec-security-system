import type { DetectionAlert, ResolveDetectionAlertRequest } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { routes } from '@/app/routes';
import { DetailRow } from '@/components/detail-row';
import { AlertStatusBadge, RuleBadge, SeverityBadge } from '@/components/detection-badges';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { useSiteNames } from '@/components/site-select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { $api } from '@/lib/api';
import {
  alertStatusLabels,
  closingLabels,
  evidenceLabel,
  evidenceText,
  ruleQuestions,
} from '@/lib/detection';
import { formatDate, formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError, isProblemDetails } from '@/lib/problem';

// The contract's rule for a resolution note.
const NOTE_MIN_LENGTH = 3;
const NOTE_MAX_LENGTH = 500;

const CLOSINGS = ['RESOLVED', 'CONFIRMED_FRAUD'] as const;

/**
 * One alert: the question a rule asked, the rows it cited, and the way to
 * answer it. Answering is what closes it — a rule never closes anything
 * itself, and a closed alert is never reopened by a later sweep.
 */
export function DetectionAlertPage() {
  const { alertId = '' } = useParams<{ alertId: string }>();
  usePageTitle('Alert');
  const alert = $api.useQuery('get', '/detection/alerts/{alertId}', {
    params: { path: { alertId } },
  });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <Link
        to={routes.detection}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Alerts
      </Link>

      {alert.isError ? (
        <LoadError
          error={alert.error}
          retrying={alert.isFetching}
          onRetry={() => void alert.refetch()}
        />
      ) : alert.isPending ? (
        <LoadingAlert />
      ) : (
        <AlertRecord alert={alert.data} />
      )}
    </div>
  );
}

function AlertRecord({ alert }: { alert: DetectionAlert }) {
  const siteNames = useSiteNames();
  const siteName = alert.subject.siteId ? (siteNames.get(alert.subject.siteId) ?? 'Site') : null;
  const { employee, device } = alert.subject;
  const about = employee?.fullName ?? device?.name ?? siteName ?? 'Alert';

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-card/60 p-5 motion-safe:animate-rise-soft">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <RuleBadge code={alert.ruleCode} />
            <SeverityBadge severity={alert.severity} />
            <AlertStatusBadge status={alert.status} />
          </div>
          <h1 className="font-semibold text-3xl tracking-tight">{about}</h1>
          <p className="text-muted-foreground text-sm tabular-nums">
            {formatDate(alert.windowFrom)}
            {alert.windowTo !== alert.windowFrom && ` – ${formatDate(alert.windowTo)}`}
            {siteName && ` · ${siteName}`}
            {device && employee && ` · ${device.name}`}
          </p>
        </div>
      </header>

      <p className="text-sm">{ruleQuestions[alert.ruleCode]}</p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="stagger-1 rounded-2xl motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="font-heading text-lg">Evidence</CardTitle>
            <CardDescription>
              The rows and numbers the rule looked at. Never a face, a template or a Ghana Card
              number.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              {employee && (
                <DetailRow term="Worker">
                  <Link
                    to={routes.employee(employee.id)}
                    className="text-primary underline underline-offset-4 hover:no-underline"
                  >
                    {employee.fullName}
                  </Link>{' '}
                  <span className="font-mono text-muted-foreground text-xs">
                    {employee.staffNumber}
                  </span>
                </DetailRow>
              )}
              {device && <DetailRow term="Device">{device.name}</DetailRow>}
              {Object.entries(alert.evidence).map(([key, value]) => (
                <DetailRow key={key} term={evidenceLabel(key)}>
                  <span className="tabular-nums">{evidenceText(key, value)}</span>
                </DetailRow>
              ))}
              <DetailRow term="Raised">
                <span className="tabular-nums">{formatDateTime(alert.openedAt)}</span>
              </DetailRow>
            </dl>
          </CardContent>
        </Card>

        <Card className="stagger-2 rounded-2xl motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="font-heading text-lg">Decision</CardTitle>
            <CardDescription>
              {alert.resolution
                ? 'This alert has been answered.'
                : 'Every decision is recorded with your name and note.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {alert.resolution ? (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
                <DetailRow term="Decision">{alertStatusLabels[alert.status]}</DetailRow>
                <DetailRow term="Note">{alert.resolution.note}</DetailRow>
                <DetailRow term="When">
                  <span className="tabular-nums">{formatDateTime(alert.resolution.decidedAt)}</span>
                </DetailRow>
              </dl>
            ) : (
              <ResolutionForm alert={alert} />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ResolutionForm({ alert }: { alert: DetectionAlert }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ResolveDetectionAlertRequest['status']>('RESOLVED');
  const [note, setNote] = useState('');
  const [mistake, setMistake] = useState<string | null>(null);

  const resolve = $api.useMutation('post', '/detection/alerts/{alertId}/resolve', {
    onSuccess: () => {
      // The alert, the queue and the risk scores all changed.
      void queryClient.invalidateQueries({ queryKey: ['get', '/detection/alerts/{alertId}'] });
      void queryClient.invalidateQueries({ queryKey: ['get', '/detection/alerts'] });
      void queryClient.invalidateQueries({ queryKey: ['get', '/detection/risk-scores'] });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (resolve.isPending) {
      return;
    }
    const trimmedNote = note.trim();
    if (trimmedNote.length < NOTE_MIN_LENGTH || trimmedNote.length > NOTE_MAX_LENGTH) {
      setMistake(`Explain the decision in ${NOTE_MIN_LENGTH} to ${NOTE_MAX_LENGTH} characters.`);
      return;
    }
    setMistake(null);
    resolve.mutate({
      params: { path: { alertId: alert.id } },
      body: { status, note: trimmedNote },
    });
  }

  const problem = resolve.error ? describeApiError(resolve.error) : undefined;

  return (
    <form noValidate onSubmit={submit} aria-busy={resolve.isPending} className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-1 font-medium text-sm">What did you find?</legend>
        {CLOSINGS.map((closing) => (
          <label key={closing} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="alert-decision"
              value={closing}
              checked={status === closing}
              onChange={() => setStatus(closing)}
              className="mt-1"
            />
            {closingLabels[closing]}
          </label>
        ))}
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor="alert-note">Note</Label>
        <Textarea
          id="alert-note"
          value={note}
          minLength={NOTE_MIN_LENGTH}
          maxLength={NOTE_MAX_LENGTH}
          rows={3}
          placeholder="How do you know? For example: HR confirms the start date was entered wrong."
          onChange={(event) => setNote(event.target.value)}
          aria-describedby="alert-note-hint"
        />
        <p id="alert-note-hint" className="text-muted-foreground text-xs">
          A rule never decides anything about a person; you do, and it is audited under your name.
          The note stays with the alert for other reviewers.
        </p>
      </div>

      {mistake && (
        <Alert variant="destructive">
          <AlertDescription>{mistake}</AlertDescription>
        </Alert>
      )}

      {problem && (
        <Alert variant="destructive">
          <AlertTitle>Could not record the decision</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
          </AlertDescription>
        </Alert>
      )}

      <div>
        <Button type="submit">{resolve.isPending ? 'Saving…' : 'Record the decision'}</Button>
      </div>
    </form>
  );
}

function LoadingAlert() {
  return (
    <div className="grid gap-4">
      <span role="status" className="sr-only">
        Loading the alert…
      </span>
      <Skeleton aria-hidden="true" className="h-28 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton aria-hidden="true" className="h-64 w-full" />
        <Skeleton aria-hidden="true" className="h-64 w-full" />
      </div>
    </div>
  );
}

interface LoadErrorProps {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}

/** A 404 gets its own wording: an unknown ID, or another company's alert. */
function LoadError({ error, retrying, onRetry }: LoadErrorProps) {
  if (isProblemDetails(error) && error.status === 404) {
    return (
      <Alert>
        <AlertTitle>No alert found</AlertTitle>
        <AlertDescription>
          <p>There is no alert with this ID that you can see.</p>
          <p className="font-mono text-xs">Trace ID: {error.traceId}</p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <LoadErrorAlert
      title="The alert could not be loaded"
      error={error}
      retrying={retrying}
      onRetry={onRetry}
    />
  );
}
