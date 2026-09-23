import type {
  AttendanceException,
  ExceptionResolutionAction,
  ResolveExceptionRequest,
  WorkSegment,
} from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { ArrowLeft } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { routes } from '@/app/routes';
import {
  ExceptionStatusBadge,
  ExceptionTypeBadge,
  SegmentStatusBadge,
} from '@/components/attendance-badges';
import { DetailRow } from '@/components/detail-row';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { useSiteNames } from '@/components/site-select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { $api } from '@/lib/api';
import {
  exceptionTypeDescriptions,
  isFlaggedMethod,
  MAX_SHIFT_HOURS,
  punchDirectionLabels,
  punchMethodLabels,
  segmentBasisLabels,
} from '@/lib/attendance';
import {
  formatDate,
  formatDateTime,
  formatMinutes,
  formatTime,
  fromGhanaLocalInput,
  toGhanaLocalInput,
} from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError, isProblemDetails } from '@/lib/problem';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

// The contract's rule for a resolution note.
const NOTE_MIN_LENGTH = 3;
const NOTE_MAX_LENGTH = 500;
/** The suggested length of a shift added by hand, before the person adjusts it. */
const SUGGESTED_SHIFT_HOURS = 12;
const HOUR_MS = 3_600_000;

const actionLabels: Record<ExceptionResolutionAction, string> = {
  DISMISS: 'Dismiss — checked, nothing to change',
  ADD_SEGMENT: 'Add the shift by hand',
  KEEP_SEGMENT: 'Keep one shift and void the other',
  VOID_ALL: 'Void both shifts',
};

/**
 * One exception with its evidence, and the way to resolve it. The API says
 * which actions this person may take (`allowedActions`); HR sees the
 * evidence but never creates hours, and nobody resolves their own attendance.
 */
export function ExceptionDetailPage() {
  const { exceptionId = '' } = useParams<{ exceptionId: string }>();
  usePageTitle('Exception');
  const exception = $api.useQuery('get', '/attendance/exceptions/{exceptionId}', {
    params: { path: { exceptionId } },
  });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <Link
        to={routes.exceptions}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Exception queue
      </Link>

      {exception.isError ? (
        <LoadError
          error={exception.error}
          retrying={exception.isFetching}
          onRetry={() => void exception.refetch()}
        />
      ) : exception.isPending ? (
        <LoadingException />
      ) : (
        <ExceptionRecord exception={exception.data} />
      )}
    </div>
  );
}

function ExceptionRecord({ exception }: { exception: AttendanceException }) {
  const siteNames = useSiteNames();
  const siteName = (siteId: string) => siteNames.get(siteId) ?? 'Site';

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-card/60 p-5 motion-safe:animate-rise-soft">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <ExceptionTypeBadge type={exception.type} />
            <ExceptionStatusBadge status={exception.status} />
          </div>
          <h1 className="font-semibold text-3xl tracking-tight">
            {exception.employee ? exception.employee.fullName : 'Unknown device user'}
          </h1>
          <p className="text-muted-foreground text-sm">
            {formatDate(exception.workDate)} · {siteName(exception.siteId)}
            {exception.secondSiteId && ` and ${siteName(exception.secondSiteId)}`}
          </p>
        </div>
      </header>

      <p className="text-sm">{exceptionTypeDescriptions[exception.type]}</p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="stagger-1 rounded-2xl motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="font-heading text-lg">Evidence</CardTitle>
            <CardDescription>What the device recorded.</CardDescription>
          </CardHeader>
          <CardContent>
            {exception.punch && <PunchEvidence exception={exception} />}
            {exception.segments.length > 0 && (
              <ul className="grid gap-3">
                {exception.segments.map((segment) => (
                  <li key={segment.id}>
                    <SegmentSummary segment={segment} siteName={siteName(segment.siteId)} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="stagger-2 rounded-2xl motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="font-heading text-lg">Decision</CardTitle>
            <CardDescription>
              {exception.status === 'OPEN'
                ? 'Every decision is recorded with your name and note.'
                : 'This exception has been dealt with.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Decision exception={exception} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function PunchEvidence({ exception }: { exception: AttendanceException }) {
  const punch = exception.punch;
  if (!punch) {
    return null;
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <DetailRow term="Punch">{punchDirectionLabels[punch.direction]}</DetailRow>
      <DetailRow term="Device time">
        <span className="tabular-nums">{formatDateTime(punch.deviceTime)}</span>
        {punch.clockSuspect && (
          <span className="ml-2 text-amber-800 dark:text-amber-300">(clock suspect)</span>
        )}
      </DetailRow>
      <DetailRow term="Received">
        <span className="tabular-nums">{formatDateTime(punch.serverTime)}</span>
      </DetailRow>
      <DetailRow term="Device">{punch.deviceName}</DetailRow>
      <DetailRow term="Device user">
        <span className="font-mono">{punch.deviceUserRef}</span>
      </DetailRow>
      <DetailRow term="Proof">
        <span className={cn(isFlaggedMethod(punch.method) && 'text-amber-800 dark:text-amber-300')}>
          {punchMethodLabels[punch.method]}
        </span>
      </DetailRow>
      {exception.employee && (
        <DetailRow term="Employee">
          <Link
            to={routes.employee(exception.employee.id)}
            className="text-primary underline underline-offset-4 hover:no-underline"
          >
            {exception.employee.fullName}
          </Link>{' '}
          <span className="font-mono text-muted-foreground text-xs">
            {exception.employee.staffNumber}
          </span>
        </DetailRow>
      )}
    </dl>
  );
}

function SegmentSummary({ segment, siteName }: { segment: WorkSegment; siteName: string }) {
  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{siteName}</span>
        <SegmentStatusBadge status={segment.status} />
      </div>
      <p className="mt-1 text-muted-foreground tabular-nums">
        {formatDate(segment.workDate)} · {formatTime(segment.startedAt)}–
        {formatTime(segment.endedAt)} · {formatMinutes(segment.workedMinutes)} ·{' '}
        {segmentBasisLabels[segment.basis]}
      </p>
    </div>
  );
}

function Decision({ exception }: { exception: AttendanceException }) {
  const session = useSession();

  if (exception.resolution) {
    return (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <DetailRow term="Decision">{actionLabels[exception.resolution.action]}</DetailRow>
        <DetailRow term="Note">{exception.resolution.note}</DetailRow>
        <DetailRow term="When">
          <span className="tabular-nums">{formatDateTime(exception.resolution.resolvedAt)}</span>
        </DetailRow>
      </dl>
    );
  }
  if (exception.status === 'AUTO_CLOSED') {
    return <p className="text-sm">Later punches cleared this on their own.</p>;
  }
  if (exception.allowedActions.length === 0) {
    const mayResolveInGeneral =
      session !== null && roleAllowed(pageRoles.resolveExceptions, session.user.role);
    return (
      <p className="text-muted-foreground text-sm">
        {mayResolveInGeneral
          ? 'You can read this exception but not resolve it: it is about your own attendance, or it reaches a site you do not run.'
          : 'HR reads the queue but never creates hours, so payroll and attendance stay in different hands.'}
      </p>
    );
  }
  return <ResolutionForm exception={exception} />;
}

function ResolutionForm({ exception }: { exception: AttendanceException }) {
  const queryClient = useQueryClient();
  const [action, setAction] = useState<ExceptionResolutionAction>(
    exception.allowedActions[0] ?? 'DISMISS',
  );
  const [segmentId, setSegmentId] = useState(exception.segments[0]?.id ?? '');
  const suggested = suggestedShift(exception);
  const [startedAt, setStartedAt] = useState(suggested.start);
  const [endedAt, setEndedAt] = useState(suggested.end);
  const [note, setNote] = useState('');
  const [mistake, setMistake] = useState<string | null>(null);

  const resolve = $api.useMutation('post', '/attendance/exceptions/{exceptionId}/resolve', {
    onSuccess: () => {
      // The exception, the queue and the shifts all changed.
      void queryClient.invalidateQueries({
        queryKey: ['get', '/attendance/exceptions/{exceptionId}'],
      });
      void queryClient.invalidateQueries({ queryKey: ['get', '/attendance/exceptions'] });
      void queryClient.invalidateQueries({ queryKey: ['get', '/attendance/segments'] });
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
    let body: ResolveExceptionRequest;
    switch (action) {
      case 'DISMISS':
        body = { action, note: trimmedNote };
        break;
      case 'VOID_ALL':
        body = { action, note: trimmedNote };
        break;
      case 'KEEP_SEGMENT':
        if (segmentId === '') {
          setMistake('Choose the shift to keep.');
          return;
        }
        body = { action, segmentId, note: trimmedNote };
        break;
      case 'ADD_SEGMENT': {
        if (startedAt === '' || endedAt === '') {
          setMistake('Give the start and the end of the shift.');
          return;
        }
        const startMs = Date.parse(fromGhanaLocalInput(startedAt));
        const endMs = Date.parse(fromGhanaLocalInput(endedAt));
        if (!(startMs < endMs)) {
          setMistake('The end must come after the start.');
          return;
        }
        if (endMs - startMs > MAX_SHIFT_HOURS * HOUR_MS) {
          setMistake(`A shift can be at most ${MAX_SHIFT_HOURS} hours long.`);
          return;
        }
        if (endMs > Date.now()) {
          setMistake('The shift must have ended already.');
          return;
        }
        const punchMs = exception.punch ? Date.parse(exception.punch.deviceTime) : Number.NaN;
        if (!Number.isNaN(punchMs) && !(startMs <= punchMs && punchMs <= endMs)) {
          setMistake("The hours must include the real punch's time.");
          return;
        }
        body = {
          action,
          startedAt: fromGhanaLocalInput(startedAt),
          endedAt: fromGhanaLocalInput(endedAt),
          note: trimmedNote,
        };
        break;
      }
      default:
        // TypeScript fails the build if the contract ever adds a fifth action.
        action satisfies never;
        return;
    }
    setMistake(null);
    resolve.mutate({ params: { path: { exceptionId: exception.id } }, body });
  }

  const problem = resolve.error ? describeApiError(resolve.error) : undefined;

  return (
    <form noValidate onSubmit={submit} aria-busy={resolve.isPending} className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-1 font-medium text-sm">What happened?</legend>
        {exception.allowedActions.map((allowed) => (
          <label key={allowed} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="resolution-action"
              value={allowed}
              checked={action === allowed}
              onChange={() => setAction(allowed)}
              className="mt-1"
            />
            {actionLabels[allowed]}
          </label>
        ))}
      </fieldset>

      {action === 'KEEP_SEGMENT' && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 font-medium text-sm">Which shift really happened?</legend>
          {exception.segments.map((segment) => (
            <label key={segment.id} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="kept-segment"
                value={segment.id}
                checked={segmentId === segment.id}
                onChange={() => setSegmentId(segment.id)}
                className="mt-1"
              />
              <span className="tabular-nums">
                {formatDate(segment.workDate)} · {formatTime(segment.startedAt)}–
                {formatTime(segment.endedAt)} · {formatMinutes(segment.workedMinutes)}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {action === 'ADD_SEGMENT' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="shift-start">Shift started (Ghana time)</Label>
            <Input
              id="shift-start"
              type="datetime-local"
              value={startedAt}
              onChange={(event) => setStartedAt(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="shift-end">Shift ended (Ghana time)</Label>
            <Input
              id="shift-end"
              type="datetime-local"
              value={endedAt}
              onChange={(event) => setEndedAt(event.target.value)}
            />
          </div>
          <p className="text-muted-foreground text-xs sm:col-span-2">
            The hours must include the real punch, last at most {MAX_SHIFT_HOURS} hours, and end in
            the past.
          </p>
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="resolution-note">Note</Label>
        <Textarea
          id="resolution-note"
          value={note}
          minLength={NOTE_MIN_LENGTH}
          maxLength={NOTE_MAX_LENGTH}
          rows={3}
          placeholder="How do you know? For example: the relief guard confirms the 06:00 handover."
          onChange={(event) => setNote(event.target.value)}
          aria-describedby="resolution-note-hint"
        />
        <p id="resolution-note-hint" className="text-muted-foreground text-xs">
          Your decision is audited under your name. The note is kept with the exception for other
          reviewers.
        </p>
      </div>

      {mistake && (
        <Alert variant="destructive">
          <AlertDescription>{mistake}</AlertDescription>
        </Alert>
      )}

      {problem && (
        <Alert variant="destructive">
          <AlertTitle>Could not resolve this exception</AlertTitle>
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

/**
 * A starting point for a shift added by hand: around the real punch, a
 * typical day-shift length long, and never ending in the future.
 */
function suggestedShift(exception: AttendanceException): { start: string; end: string } {
  const punchMs = exception.punch ? Date.parse(exception.punch.deviceTime) : Number.NaN;
  if (Number.isNaN(punchMs)) {
    return { start: '', end: '' };
  }
  const now = Date.now();
  if (exception.type === 'MISSING_CLOCK_IN') {
    return {
      start: toGhanaLocalInput(new Date(punchMs - SUGGESTED_SHIFT_HOURS * HOUR_MS).toISOString()),
      end: toGhanaLocalInput(new Date(punchMs).toISOString()),
    };
  }
  const end = Math.min(punchMs + SUGGESTED_SHIFT_HOURS * HOUR_MS, now);
  return {
    start: toGhanaLocalInput(new Date(punchMs).toISOString()),
    end: toGhanaLocalInput(new Date(end).toISOString()),
  };
}

function LoadingException() {
  return (
    <div className="grid gap-4">
      <span role="status" className="sr-only">
        Loading the exception…
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

/** A 404 gets its own wording: unknown ID, or a site this person does not run. */
function LoadError({ error, retrying, onRetry }: LoadErrorProps) {
  if (isProblemDetails(error) && error.status === 404) {
    return (
      <Alert>
        <AlertTitle>No exception found</AlertTitle>
        <AlertDescription>
          <p>There is no exception with this ID that you can see.</p>
          <p className="font-mono text-xs">Trace ID: {error.traceId}</p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <LoadErrorAlert
      title="The exception could not be loaded"
      error={error}
      retrying={retrying}
      onRetry={onRetry}
    />
  );
}
