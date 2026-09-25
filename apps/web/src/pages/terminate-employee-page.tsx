import type { TerminationReason } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { routes } from '@/app/routes';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { SelectField } from '@/components/select-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { $api } from '@/lib/api';
import { formatDate, todayInGhana } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError, isProblemDetails } from '@/lib/problem';

/** The contract's limit on `note`. */
const NOTE_MAX_LENGTH = 500;
const PROBLEM_ID = 'terminate-problem';

/** Every reason, in the order the drop-down lists them, in plain words. */
const REASONS: ReadonlyArray<{ value: TerminationReason; label: string }> = [
  { value: 'RESIGNED', label: 'Resigned — they chose to leave' },
  { value: 'CONTRACT_ENDED', label: 'Contract ended' },
  { value: 'DISMISSED', label: 'Dismissed — the company ended it' },
  { value: 'ABSCONDED', label: 'Absconded — stopped reporting without notice' },
  { value: 'DECEASED', label: 'Deceased' },
  { value: 'OTHER', label: 'Other — explain below' },
];

function isReason(value: string): value is TerminationReason {
  return REASONS.some((reason) => reason.value === value);
}

/**
 * Records that an employee has left (ADMIN and HR_PAYROLL).
 *
 * This is a one-way door, and it gets its own page for that reason. Nobody is
 * ever deleted: the record stays for history, their attendance and payslips
 * stay readable, and only their future is closed — they can no longer clock in
 * and they leave the payroll.
 */
export function TerminateEmployeePage() {
  const { employeeId = '' } = useParams<{ employeeId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const employee = $api.useQuery('get', '/employees/{employeeId}', {
    params: { path: { employeeId } },
  });
  usePageTitle(employee.data ? `End ${employee.data.staffNumber}` : 'End employment');

  const [effectiveDate, setEffectiveDate] = useState(todayInGhana);
  const [reason, setReason] = useState<TerminationReason>('RESIGNED');
  const [note, setNote] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [mistake, setMistake] = useState<string | null>(null);

  const terminate = $api.useMutation('post', '/employees/{employeeId}/terminate', {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['get', '/employees'] });
      void navigate(routes.employee(employeeId));
    },
  });

  const record = employee.data;
  const staffNumber = record?.staffNumber ?? '';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (terminate.isPending || record === undefined) {
      return;
    }
    const explanation = note.trim();
    if (effectiveDate === '') {
      setMistake('Choose their last working day.');
      return;
    }
    if (effectiveDate < record.hireDate) {
      setMistake('The last working day cannot be before the day they started.');
      return;
    }
    if (reason === 'OTHER' && explanation === '') {
      setMistake('Explain the reason in the note when the reason is "Other".');
      return;
    }
    // Typing the staff number is the last check against ending the wrong
    // person's employment from a list of similar names.
    if (confirmation.trim().toUpperCase() !== staffNumber.toUpperCase()) {
      setMistake(`Type ${staffNumber} to confirm this is the right person.`);
      return;
    }
    setMistake(null);
    terminate.mutate({
      params: { path: { employeeId } },
      body: {
        effectiveDate,
        reason,
        // The contract wants the field left out, not empty.
        ...(explanation !== '' && { note: explanation }),
      },
    });
  }

  const badField = isProblemDetails(terminate.error)
    ? terminate.error.errors?.[0]?.path
    : undefined;
  const problem = terminate.error ? describeApiError(terminate.error) : undefined;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Link
        to={record ? routes.employee(employeeId) : routes.employees}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {staffNumber === '' ? 'Employees' : staffNumber}
      </Link>

      <PageHeader eyebrow="Workforce" title="End employment" />

      {employee.isError ? (
        <LoadErrorAlert
          title="The employee could not be loaded"
          error={employee.error}
          retrying={employee.isFetching}
          onRetry={() => void employee.refetch()}
        />
      ) : employee.isPending ? (
        <>
          <span role="status" className="sr-only">
            Loading employee…
          </span>
          <Skeleton aria-hidden="true" className="h-80 w-full" />
        </>
      ) : employee.data.status === 'TERMINATED' ? (
        <Alert>
          <AlertTitle>This has already been recorded</AlertTitle>
          <AlertDescription>
            <p>
              {employee.data.fullName} left on{' '}
              {employee.data.terminationDate ? formatDate(employee.data.terminationDate) : 'a date'}
              . It can only be recorded once.
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <Card className="rounded-2xl border-destructive/40 motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-heading text-lg">
              <TriangleAlert aria-hidden="true" className="size-4 text-destructive" />
              {employee.data.fullName}
            </CardTitle>
            <CardDescription>
              <span className="font-mono">{employee.data.staffNumber}</span> · started{' '}
              {formatDate(employee.data.hireDate)}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Alert>
              <AlertTitle>What this does, and what it does not</AlertTitle>
              <AlertDescription>
                <p>
                  They stop being able to clock in, and they leave the payroll from their last
                  working day. Nothing is deleted: the record, their shifts and their payslips all
                  stay, because a company must be able to show what it paid and why.
                </p>
                <p>It can only be recorded once, so check the name above.</p>
              </AlertDescription>
            </Alert>

            {/* noValidate: the page's own messages are clearer than the browser's. */}
            <form
              noValidate
              onSubmit={submit}
              aria-busy={terminate.isPending}
              className="grid gap-4"
            >
              <div className="grid gap-1.5">
                <Label htmlFor="terminate-date">Last working day</Label>
                <Input
                  id="terminate-date"
                  type="date"
                  required
                  min={employee.data.hireDate}
                  value={effectiveDate}
                  onChange={(event) => setEffectiveDate(event.target.value)}
                  aria-invalid={badField === 'effectiveDate' || undefined}
                  aria-describedby={badField === 'effectiveDate' ? PROBLEM_ID : undefined}
                  className="w-48"
                />
              </div>

              <SelectField
                id="terminate-reason"
                label="Reason"
                value={reason}
                invalid={badField === 'reason'}
                describedBy={badField === 'reason' ? PROBLEM_ID : undefined}
                onChange={(value) => {
                  if (isReason(value)) {
                    setReason(value);
                  }
                }}
              >
                {REASONS.map((one) => (
                  <option key={one.value} value={one.value}>
                    {one.label}
                  </option>
                ))}
              </SelectField>

              <div className="grid gap-1.5">
                <Label htmlFor="terminate-note">
                  Note {reason === 'OTHER' ? '(required)' : '(optional)'}
                </Label>
                <Textarea
                  id="terminate-note"
                  rows={3}
                  maxLength={NOTE_MAX_LENGTH}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  aria-invalid={badField === 'note' || undefined}
                  aria-describedby={badField === 'note' ? PROBLEM_ID : undefined}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="terminate-confirm">
                  Type {employee.data.staffNumber} to confirm
                </Label>
                <Input
                  id="terminate-confirm"
                  required
                  autoComplete="off"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  className="w-48 font-mono"
                />
              </div>

              {mistake && (
                <Alert variant="destructive">
                  <AlertDescription>{mistake}</AlertDescription>
                </Alert>
              )}

              {problem && (
                <Alert id={PROBLEM_ID} variant="destructive">
                  <AlertTitle>Could not record this</AlertTitle>
                  <AlertDescription>
                    <p>{problem.message}</p>
                    {problem.traceId && (
                      <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap gap-3">
                <Button type="submit" variant="destructive" disabled={terminate.isPending}>
                  {terminate.isPending ? 'Recording…' : 'Record that they have left'}
                </Button>
                <Button asChild variant="outline">
                  <Link to={routes.employee(employeeId)}>Cancel</Link>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
