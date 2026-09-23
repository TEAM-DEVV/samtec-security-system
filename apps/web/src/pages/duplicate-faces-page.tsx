import type {
  BiometricCollision,
  CollisionStatus,
  ResolveCollisionRequest,
} from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { ScanFace } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { CollisionStatusBadge } from '@/components/biometrics-badges';
import { DetailRow } from '@/components/detail-row';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { SelectField } from '@/components/select-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { $api } from '@/lib/api';
import {
  COLLISION_STATUSES,
  collisionStatusLabels,
  formatSimilarity,
  isCollisionStatus,
  verdictLabels,
} from '@/lib/biometrics';
import { useCursorPages } from '@/lib/cursor-pages';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError } from '@/lib/problem';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 20;
const NOTE_MIN_LENGTH = 3;
const NOTE_MAX_LENGTH = 500;

/**
 * The duplicate-enrollment queue (ADMIN only): each item is a new face that
 * looked like someone already enrolled, which is exactly what a ghost worker
 * enrolled twice looks like. A second ADMIN checks both Ghana Cards in
 * person and decides; the one who enrolled the face never does.
 */
export function DuplicateFacesPage() {
  usePageTitle('Duplicate faces');
  const [status, setStatus] = useState<CollisionStatus>('OPEN');
  const pages = useCursorPages();

  const collisions = $api.useQuery(
    'get',
    '/biometric-collisions',
    { params: { query: { status, limit: PAGE_SIZE, cursor: pages.cursor } } },
    { placeholderData: (previous) => previous },
  );
  const showingOldPage = collisions.isPlaceholderData;
  const nextCursor = collisions.error ? null : (collisions.data?.nextCursor ?? null);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow="Biometrics"
        title="Duplicate faces"
        description="A new face that looked like someone already enrolled. Check both people's Ghana Cards in person, then decide."
      />

      <div className="flex flex-wrap items-start gap-4 rounded-2xl border bg-card/60 p-4">
        <SelectField
          id="duplicates-status"
          label="Status"
          value={status}
          onChange={(value) => {
            if (isCollisionStatus(value)) {
              setStatus(value);
              pages.reset();
            }
          }}
        >
          {COLLISION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {collisionStatusLabels[value]}
            </option>
          ))}
        </SelectField>
      </div>

      {collisions.error ? (
        <LoadErrorAlert
          title="The queue could not be loaded"
          error={collisions.error}
          retrying={collisions.isFetching}
          onRetry={() => void collisions.refetch()}
        />
      ) : collisions.isPending ? (
        <div className="grid gap-4">
          <span role="status" className="sr-only">
            Loading the queue…
          </span>
          <Skeleton aria-hidden="true" className="h-40 w-full" />
          <Skeleton aria-hidden="true" className="h-40 w-full" />
        </div>
      ) : collisions.data.items.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <ScanFace aria-hidden="true" className="size-8 text-muted-foreground" />
            <p className="font-medium">
              {status === 'OPEN' ? 'Nothing waits for a decision.' : 'Nothing decided yet.'}
            </p>
            <p className="text-muted-foreground text-sm">
              Every new face is compared with everyone enrolled; the ones that look alike land here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div
          aria-busy={showingOldPage}
          className={cn('grid gap-4 transition-opacity', showingOldPage && 'opacity-60')}
        >
          {collisions.data.items.map((collision, index) => (
            <CollisionCard
              key={collision.credentialId}
              collision={collision}
              className={index < 4 ? `stagger-${index + 1}` : undefined}
            />
          ))}
        </div>
      )}

      <PaginationNav pages={pages} nextCursor={nextCursor} busy={showingOldPage} />
    </div>
  );
}

function CollisionCard({
  collision,
  className,
}: {
  collision: BiometricCollision;
  className?: string;
}) {
  return (
    <Card className={cn('rounded-2xl motion-safe:animate-rise-soft', className)}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="font-heading text-lg">
            <EmployeeLink employee={collision.employee} /> looked like{' '}
            <EmployeeLink employee={collision.lookedLike} />
          </CardTitle>
          <CollisionStatusBadge status={collision.status} />
        </div>
        <CardDescription className="tabular-nums">
          {formatSimilarity(collision.similarity)} · enrolled {formatDateTime(collision.enrolledAt)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {collision.resolution ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <DetailRow term="Decision">{verdictLabels[collision.resolution.verdict]}</DetailRow>
            {collision.resolution.keptEmployeeId && (
              <DetailRow term="Kept">
                {collision.resolution.keptEmployeeId === collision.employee.id
                  ? collision.employee.fullName
                  : collision.lookedLike.fullName}
                <span className="text-muted-foreground"> (the other record is blocked)</span>
              </DetailRow>
            )}
            <DetailRow term="Note">{collision.resolution.note}</DetailRow>
            <DetailRow term="When">
              <span className="tabular-nums">
                {formatDateTime(collision.resolution.resolvedAt)}
              </span>
            </DetailRow>
          </dl>
        ) : (
          <DecisionForm collision={collision} />
        )}
      </CardContent>
    </Card>
  );
}

function EmployeeLink({ employee }: { employee: BiometricCollision['employee'] }) {
  return (
    <>
      <Link
        to={routes.employee(employee.id)}
        className="text-primary underline underline-offset-4 hover:no-underline"
      >
        {employee.fullName}
      </Link>{' '}
      <span className="font-mono font-normal text-muted-foreground text-sm">
        {employee.staffNumber}
      </span>
    </>
  );
}

function DecisionForm({ collision }: { collision: BiometricCollision }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [verdict, setVerdict] = useState<ResolveCollisionRequest['verdict']>('DIFFERENT_PEOPLE');
  const [keepEmployeeId, setKeepEmployeeId] = useState('');
  const [note, setNote] = useState('');
  const [mistake, setMistake] = useState<string | null>(null);

  const resolve = $api.useMutation('post', '/biometric-collisions/{credentialId}/resolve', {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['get', '/biometric-collisions'] });
      // Both records' faces may have changed.
      void queryClient.invalidateQueries({
        queryKey: ['get', '/employees/{employeeId}/biometrics'],
      });
      void queryClient.invalidateQueries({ queryKey: ['get', '/employees/{employeeId}'] });
      void queryClient.invalidateQueries({ queryKey: ['get', '/employees'] });
    },
  });

  if (session?.user.id === collision.enrolledByUserId) {
    return (
      <p className="text-muted-foreground text-sm">
        You enrolled this face, so another administrator must decide it.
      </p>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (resolve.isPending) return;
    const trimmed = note.trim();
    if (trimmed.length < NOTE_MIN_LENGTH || trimmed.length > NOTE_MAX_LENGTH) {
      setMistake(`Explain the decision in ${NOTE_MIN_LENGTH} to ${NOTE_MAX_LENGTH} characters.`);
      return;
    }
    let body: ResolveCollisionRequest;
    if (verdict === 'SAME_PERSON') {
      if (keepEmployeeId === '') {
        setMistake('Choose the record that belongs to the person whose card you checked.');
        return;
      }
      body = { verdict, keepEmployeeId, note: trimmed };
    } else {
      body = { verdict, note: trimmed };
    }
    setMistake(null);
    resolve.mutate({ params: { path: { credentialId: collision.credentialId } }, body });
  }

  const problem = resolve.error ? describeApiError(resolve.error) : undefined;
  const fieldId = (name: string) => `${collision.credentialId}-${name}`;

  return (
    <form noValidate onSubmit={submit} aria-busy={resolve.isPending} className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-1 font-medium text-sm">What did the Ghana Cards show?</legend>
        {(['DIFFERENT_PEOPLE', 'SAME_PERSON'] as const).map((value) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={fieldId('verdict')}
              value={value}
              checked={verdict === value}
              onChange={() => setVerdict(value)}
              className="mt-1"
            />
            {verdictLabels[value]}
          </label>
        ))}
      </fieldset>

      {verdict === 'SAME_PERSON' && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 font-medium text-sm">
            Which record belongs to the person whose card you checked? The other is blocked for
            good.
          </legend>
          {[collision.employee, collision.lookedLike].map((employee) => (
            <label key={employee.id} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={fieldId('keep')}
                value={employee.id}
                checked={keepEmployeeId === employee.id}
                onChange={() => setKeepEmployeeId(employee.id)}
                className="mt-1"
              />
              <span>
                {employee.fullName}{' '}
                <span className="font-mono text-muted-foreground text-xs">
                  {employee.staffNumber}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor={fieldId('note')}>Note</Label>
        <Textarea
          id={fieldId('note')}
          value={note}
          minLength={NOTE_MIN_LENGTH}
          maxLength={NOTE_MAX_LENGTH}
          rows={3}
          placeholder="For example: both cards checked in person; brothers."
          onChange={(event) => setNote(event.target.value)}
          aria-describedby={fieldId('note-hint')}
          aria-invalid={mistake !== null || undefined}
        />
        <p id={fieldId('note-hint')} className="text-muted-foreground text-xs">
          Your decision is audited under your name and is final. Facts only: never religion or
          health details.
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
