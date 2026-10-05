import type {
  EmployeePaymentDetails,
  EmployeePayTerms,
  SetEmployeePaymentDetailsRequest,
  SetEmployeePayTermsRequest,
} from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { DetailRow } from '@/components/detail-row';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { formatCedis, formatDate, todayInGhana } from '@/lib/format';
import { parseCedisInput, pesewasToCedisInput } from '@/lib/payroll';
import { describeApiError, isProblemDetails } from '@/lib/problem';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

/**
 * The Pay card on an employee's page: what they are paid, and where it is
 * sent (docs/plan/09-payroll-engine-ghana.md). ADMIN and HR_PAYROLL only — a
 * supervisor runs rosters and never money, and a guard reads only their own
 * payslips, so the card does not exist for either.
 *
 * Pay terms are history: "editing" them here never changes a row, it adds one
 * effective from the chosen day, exactly what the API's `PUT` does. Payment
 * details are a current address and personal data, read back from their own
 * `GET`, which answers 404 — never an object of nulls — until the first time
 * something is saved.
 */
export function PayPanel({ employeeId }: { employeeId: string }) {
  const session = useSession();
  const mayManage = session !== null && roleAllowed(pageRoles.employeePay, session.user.role);
  // Newest first, and this card only ever shows the newest: the same row a
  // payroll run would copy from if it ran today.
  const terms = $api.useQuery(
    'get',
    '/employees/{employeeId}/pay-terms',
    { params: { path: { employeeId }, query: { limit: 1 } } },
    { enabled: mayManage },
  );

  if (!mayManage) {
    return null;
  }

  const noPayTermsYet = terms.isSuccess && terms.data.items.length === 0;

  return (
    <Card className="stagger-4 rounded-2xl motion-safe:animate-rise-soft">
      <CardHeader>
        <CardTitle className="font-heading text-lg">Pay</CardTitle>
        <CardDescription>What this worker is paid, and where it is sent.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {noPayTermsYet && (
          <Alert>
            <AlertDescription>
              No pay terms yet. Add them, or this worker is left out of every payroll run.
            </AlertDescription>
          </Alert>
        )}
        <PayTermsSection employeeId={employeeId} />
        <PaymentDetailsSection employeeId={employeeId} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pay terms
// ---------------------------------------------------------------------------

function PayTermsSection({ employeeId }: { employeeId: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const terms = $api.useQuery('get', '/employees/{employeeId}/pay-terms', {
    params: { path: { employeeId }, query: { limit: 1 } },
  });
  const current = terms.data?.items[0];

  const save = $api.useMutation('put', '/employees/{employeeId}/pay-terms', {
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({
        queryKey: ['get', '/employees/{employeeId}/pay-terms'],
      });
    },
  });

  function startEditing() {
    save.reset();
    setEditing(true);
  }

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Pay terms</h3>
        {!editing && !terms.isPending && (
          <Button variant="outline" size="sm" onClick={startEditing}>
            Edit pay terms
          </Button>
        )}
      </div>

      {terms.isError ? (
        <LoadErrorAlert
          title="Pay terms could not be loaded"
          error={terms.error}
          retrying={terms.isFetching}
          onRetry={() => void terms.refetch()}
        />
      ) : terms.isPending ? (
        <div className="grid gap-2">
          <span role="status" className="sr-only">
            Loading pay terms…
          </span>
          <Skeleton aria-hidden="true" className="h-5 w-3/4" />
          <Skeleton aria-hidden="true" className="h-5 w-1/2" />
        </div>
      ) : (
        current && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <DetailRow term="Basic monthly pay">
              {formatCedis(current.basicMonthlyPesewas)}
            </DetailRow>
            <DetailRow term="Overtime rate, per hour">
              {formatCedis(current.overtimeHourlyPesewas)}
            </DetailRow>
            <DetailRow term="Taxable allowance">
              {formatCedis(current.taxableAllowancePesewas)}
            </DetailRow>
            <DetailRow term="Non-taxable allowance">
              {formatCedis(current.nonTaxableAllowancePesewas)}
            </DetailRow>
            <DetailRow term="Other deduction">
              {formatCedis(current.otherDeductionPesewas)}
            </DetailRow>
            <DetailRow term="Effective from">{formatDate(current.effectiveFrom)}</DetailRow>
          </dl>
        )
      )}

      {editing && (
        <PayTermsForm
          current={current}
          pending={save.isPending}
          error={save.error}
          onCancel={() => {
            save.reset();
            setEditing(false);
          }}
          onSubmit={(body) => save.mutate({ params: { path: { employeeId } }, body })}
        />
      )}
    </section>
  );
}

interface PayTermsFormProps {
  current: EmployeePayTerms | undefined;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (body: SetEmployeePayTermsRequest) => void;
}

const MONEY_HINT = 'Enter each amount like 1200 or 1234.56, with at most two decimal places.';

/**
 * Always starts a fresh row from today, never from the row being shown: pay
 * terms are never edited, so pre-filling the old `effectiveFrom` would only
 * invite the 409 the API answers for two rows starting the same day.
 */
function PayTermsForm({ current, pending, error, onCancel, onSubmit }: PayTermsFormProps) {
  const [effectiveFrom, setEffectiveFrom] = useState(todayInGhana());
  const [basicMonthly, setBasicMonthly] = useState(
    pesewasToCedisInput(current?.basicMonthlyPesewas ?? 0),
  );
  const [overtimeHourly, setOvertimeHourly] = useState(
    pesewasToCedisInput(current?.overtimeHourlyPesewas ?? 0),
  );
  const [taxableAllowance, setTaxableAllowance] = useState(
    pesewasToCedisInput(current?.taxableAllowancePesewas ?? 0),
  );
  const [nonTaxableAllowance, setNonTaxableAllowance] = useState(
    pesewasToCedisInput(current?.nonTaxableAllowancePesewas ?? 0),
  );
  const [otherDeduction, setOtherDeduction] = useState(
    pesewasToCedisInput(current?.otherDeductionPesewas ?? 0),
  );
  const [mistake, setMistake] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    if (effectiveFrom === '') {
      setMistake('Choose the date these terms start from.');
      return;
    }
    const basicMonthlyPesewas = parseCedisInput(basicMonthly);
    const overtimeHourlyPesewas = parseCedisInput(overtimeHourly);
    const taxableAllowancePesewas = parseCedisInput(taxableAllowance);
    const nonTaxableAllowancePesewas = parseCedisInput(nonTaxableAllowance);
    const otherDeductionPesewas = parseCedisInput(otherDeduction);
    if (
      basicMonthlyPesewas === null ||
      overtimeHourlyPesewas === null ||
      taxableAllowancePesewas === null ||
      nonTaxableAllowancePesewas === null ||
      otherDeductionPesewas === null
    ) {
      setMistake(MONEY_HINT);
      return;
    }
    setMistake(null);
    onSubmit({
      effectiveFrom,
      basicMonthlyPesewas,
      overtimeHourlyPesewas,
      taxableAllowancePesewas,
      nonTaxableAllowancePesewas,
      otherDeductionPesewas,
    });
  }

  const problem = error ? describeApiError(error) : undefined;

  return (
    <form noValidate onSubmit={submit} aria-busy={pending} className="grid gap-4 border-t pt-4">
      <div className="grid gap-1.5 sm:w-56">
        <Label htmlFor="pay-terms-effective-from">Effective from</Label>
        <Input
          id="pay-terms-effective-from"
          type="date"
          required
          value={effectiveFrom}
          onChange={(event) => setEffectiveFrom(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          The day these terms start. An earlier row is never changed, so a payslip already sent
          never moves.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="pay-terms-basic">Basic monthly pay (GH₵)</Label>
          <Input
            id="pay-terms-basic"
            inputMode="decimal"
            placeholder="0.00"
            value={basicMonthly}
            onChange={(event) => setBasicMonthly(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pay-terms-overtime">Overtime rate per hour (GH₵)</Label>
          <Input
            id="pay-terms-overtime"
            inputMode="decimal"
            placeholder="0.00"
            value={overtimeHourly}
            onChange={(event) => setOvertimeHourly(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pay-terms-taxable">Taxable allowance (GH₵)</Label>
          <Input
            id="pay-terms-taxable"
            inputMode="decimal"
            placeholder="0.00"
            value={taxableAllowance}
            onChange={(event) => setTaxableAllowance(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pay-terms-non-taxable">Non-taxable allowance (GH₵)</Label>
          <Input
            id="pay-terms-non-taxable"
            inputMode="decimal"
            placeholder="0.00"
            value={nonTaxableAllowance}
            onChange={(event) => setNonTaxableAllowance(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pay-terms-other-deduction">Other deduction (GH₵)</Label>
          <Input
            id="pay-terms-other-deduction"
            inputMode="decimal"
            placeholder="0.00"
            value={otherDeduction}
            onChange={(event) => setOtherDeduction(event.target.value)}
          />
        </div>
      </div>

      {mistake && (
        <Alert variant="destructive">
          <AlertDescription>{mistake}</AlertDescription>
        </Alert>
      )}
      {problem && (
        <Alert variant="destructive">
          <AlertTitle>Could not save pay terms</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save pay terms'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Payment details
// ---------------------------------------------------------------------------

function PaymentDetailsSection({ employeeId }: { employeeId: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const details = $api.useQuery('get', '/employees/{employeeId}/payment-details', {
    params: { path: { employeeId } },
  });
  // The row only starts to exist once something is saved: a 404 here means
  // "not on file", not a failure to show.
  const notOnFileYet = isProblemDetails(details.error) && details.error.status === 404;
  const current = notOnFileYet ? undefined : details.data;

  const save = $api.useMutation('put', '/employees/{employeeId}/payment-details', {
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({
        queryKey: ['get', '/employees/{employeeId}/payment-details'],
      });
    },
  });

  function startEditing() {
    save.reset();
    setEditing(true);
  }

  return (
    <section className="grid gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Payment details</h3>
        {!editing && !details.isPending && (
          <Button variant="outline" size="sm" onClick={startEditing}>
            Edit payment details
          </Button>
        )}
      </div>

      {details.isError && !notOnFileYet ? (
        <LoadErrorAlert
          title="Payment details could not be loaded"
          error={details.error}
          retrying={details.isFetching}
          onRetry={() => void details.refetch()}
        />
      ) : details.isPending ? (
        <div className="grid gap-2">
          <span role="status" className="sr-only">
            Loading payment details…
          </span>
          <Skeleton aria-hidden="true" className="h-5 w-3/4" />
          <Skeleton aria-hidden="true" className="h-5 w-1/2" />
        </div>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <DetailRow term="Bank name">{current?.bankName ?? <NotOnFile />}</DetailRow>
          <DetailRow term="Account name">{current?.accountName ?? <NotOnFile />}</DetailRow>
          <DetailRow term="Bank account">
            {current?.accountNumberEndsWith ? (
              <span className="font-mono">Bank account ending {current.accountNumberEndsWith}</span>
            ) : (
              <NotOnFile />
            )}
          </DetailRow>
          <DetailRow term="Mobile money">
            {current?.momoNumberEndsWith ? (
              <span className="font-mono">Mobile money ending {current.momoNumberEndsWith}</span>
            ) : (
              <NotOnFile />
            )}
          </DetailRow>
        </dl>
      )}

      {editing && (
        <PaymentDetailsForm
          current={current}
          pending={save.isPending}
          error={save.error}
          onCancel={() => {
            save.reset();
            setEditing(false);
          }}
          onSubmit={(body) => save.mutate({ params: { path: { employeeId } }, body })}
        />
      )}
    </section>
  );
}

function NotOnFile() {
  return <span className="text-muted-foreground">Not on file</span>;
}

interface PaymentDetailsFormProps {
  current: EmployeePaymentDetails | undefined;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (body: SetEmployeePaymentDetailsRequest) => void;
}

const BANK_TEXT_MIN = 2;
const BANK_TEXT_MAX = 100;
const ACCOUNT_NUMBER_SHAPE = /^[0-9]{5,20}$/;
const MOMO_SHAPE = /^\+233\d{9}$/;
/** The same characters the API refuses to start a bank-file value with. */
const FORBIDDEN_LEADING_CHARACTER = /^[\s"=+@-]/;

function PaymentDetailsForm({
  current,
  pending,
  error,
  onCancel,
  onSubmit,
}: PaymentDetailsFormProps) {
  const [bankName, setBankName] = useState(current?.bankName ?? '');
  const [accountName, setAccountName] = useState(current?.accountName ?? '');
  // Never pre-filled: the API only ever hands back the last four digits, never
  // enough to reconstruct the full number these boxes would need to show.
  const [accountNumber, setAccountNumber] = useState('');
  const [momoNumber, setMomoNumber] = useState('');
  const [mistake, setMistake] = useState<string | null>(null);

  /** Null when `value` (already trimmed) is fine to send, including empty. */
  function bankTextMistake(value: string, label: string): string | null {
    if (value === '') {
      return null;
    }
    if (value.length < BANK_TEXT_MIN || value.length > BANK_TEXT_MAX) {
      return `${label}: enter ${BANK_TEXT_MIN} to ${BANK_TEXT_MAX} characters, or leave it empty.`;
    }
    if (FORBIDDEN_LEADING_CHARACTER.test(value)) {
      return `${label} may not start with a space, a quote, or any of = + - @, because it is written into the bank file.`;
    }
    return null;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    const trimmedBankName = bankName.trim();
    const trimmedAccountName = accountName.trim();
    const trimmedAccountNumber = accountNumber.trim();
    const trimmedMomoNumber = momoNumber.trim();

    const textMistake =
      bankTextMistake(trimmedBankName, 'Bank name') ??
      bankTextMistake(trimmedAccountName, 'Account name');
    if (textMistake) {
      setMistake(textMistake);
      return;
    }
    if (trimmedAccountNumber !== '' && !ACCOUNT_NUMBER_SHAPE.test(trimmedAccountNumber)) {
      setMistake('Account number: 5 to 20 digits, or leave it empty.');
      return;
    }
    if (trimmedMomoNumber !== '' && !MOMO_SHAPE.test(trimmedMomoNumber)) {
      setMistake(
        'Mobile money number must be +233 followed by 9 digits, like +233241234567, or left empty.',
      );
      return;
    }
    setMistake(null);
    onSubmit({
      bankName: trimmedBankName === '' ? null : trimmedBankName,
      accountName: trimmedAccountName === '' ? null : trimmedAccountName,
      accountNumber: trimmedAccountNumber === '' ? null : trimmedAccountNumber,
      momoNumber: trimmedMomoNumber === '' ? null : trimmedMomoNumber,
    });
  }

  const problem = error ? describeApiError(error) : undefined;

  return (
    <form noValidate onSubmit={submit} aria-busy={pending} className="grid gap-4 border-t pt-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="payment-details-bank-name">Bank name</Label>
          <Input
            id="payment-details-bank-name"
            autoComplete="off"
            value={bankName}
            onChange={(event) => setBankName(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="payment-details-account-name">Account name</Label>
          <Input
            id="payment-details-account-name"
            autoComplete="off"
            value={accountName}
            onChange={(event) => setAccountName(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="payment-details-account-number">Account number</Label>
          <Input
            id="payment-details-account-number"
            inputMode="numeric"
            autoComplete="off"
            className="font-mono"
            value={accountNumber}
            onChange={(event) => setAccountNumber(event.target.value)}
            aria-describedby="payment-details-number-hint"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="payment-details-momo">Mobile money number</Label>
          <Input
            id="payment-details-momo"
            inputMode="tel"
            autoComplete="off"
            placeholder="+233241234567"
            value={momoNumber}
            onChange={(event) => setMomoNumber(event.target.value)}
            aria-describedby="payment-details-number-hint"
          />
        </div>
      </div>

      <p id="payment-details-number-hint" className="text-muted-foreground text-xs">
        The account number and the mobile money number are shown only as their last four digits, so
        those two boxes always start empty. Type the full number to change it, or leave it blank to
        clear it — the same as leaving the bank name or account name blank.
      </p>

      <p className="text-muted-foreground text-xs">
        This is what the monthly bank file pays into. Saving asks for the administrator's password.
      </p>

      {mistake && (
        <Alert variant="destructive">
          <AlertDescription>{mistake}</AlertDescription>
        </Alert>
      )}
      {problem && (
        <Alert variant="destructive">
          <AlertTitle>Could not save payment details</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save payment details'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
