import type { UserAccount, UserRole } from '@samtec/contracts';
import { type FormEvent, useState } from 'react';
import { EmployeeSelect } from '@/components/employee-select';
import { SelectField } from '@/components/select-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { describeApiError, isProblemDetails } from '@/lib/problem';
import { roleLabels, roleNeedsEmployee } from '@/lib/roles';

// The contract's limits (`CreateUserRequest`, `PersonFullName`).
const EMAIL_MAX_LENGTH = 254;
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 120;
/** The same simple shape check the mock API makes; the real API checks properly. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;

/** Every role, in the order the drop-down lists them. */
const ROLES: readonly UserRole[] = ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR', 'GUARD'];

// Ids that link a field to the text explaining it, for screen readers.
const PROBLEM_ID = 'account-form-problem';
const LOCK_NOTE_ID = 'account-form-lock-note';

function isUserRole(value: string): value is UserRole {
  return ROLES.some((role) => role === value);
}

/** What the form collects. `employeeId` is `null` for roles without an employee link. */
export interface UserAccountValues {
  email: string;
  fullName: string;
  role: UserRole;
  employeeId: string | null;
}

interface UserAccountFormProps {
  /** The account being changed; leave out when creating one. */
  initial?: UserAccount;
  /**
   * True when an administrator edits their own account: the API then allows
   * only the name to change, so the other fields are locked.
   */
  selfAccount?: boolean;
  /** True for a switched-off account: the API refuses every change until it is switched on. */
  locked?: boolean;
  submitLabel: string;
  pending: boolean;
  /** The last failed request, if any. */
  error: unknown;
  onSubmit: (values: UserAccountValues) => void;
}

/**
 * The fields of a sign-in account, shared by "Add account" and the account
 * page. The API checks everything again; the checks here only catch the
 * obvious before a request is sent.
 */
export function UserAccountForm({
  initial,
  selfAccount = false,
  locked = false,
  submitLabel,
  pending,
  error,
  onSubmit,
}: UserAccountFormProps) {
  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [role, setRole] = useState<UserRole>(initial?.role ?? 'GUARD');
  const [employeeId, setEmployeeId] = useState(initial?.employeeId ?? '');
  const [mistake, setMistake] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || locked) {
      return;
    }
    const name = fullName.trim();
    const address = email.trim();
    if (name.length < NAME_MIN_LENGTH) {
      setMistake(`The name needs at least ${NAME_MIN_LENGTH} characters.`);
      return;
    }
    if (!EMAIL_SHAPE.test(address) || address.length > EMAIL_MAX_LENGTH) {
      setMistake('Enter a valid email address.');
      return;
    }
    if (roleNeedsEmployee(role) && employeeId === '') {
      setMistake(`A ${roleLabels[role].toLowerCase()} account must be linked to an employee.`);
      return;
    }
    setMistake(null);
    onSubmit({
      email: address,
      fullName: name,
      role,
      employeeId: roleNeedsEmployee(role) ? employeeId : null,
    });
  }

  // The field the API complained about, so it can be marked and point at the message.
  const badField = isProblemDetails(error) ? error.errors?.[0]?.path : undefined;
  const problem = error ? describeApiError(error) : undefined;
  const describedBy = (field: string) => (badField === field ? PROBLEM_ID : undefined);
  // Fields other than the name are locked on your own account, and everything on a switched-off one.
  const fieldsLocked = locked || selfAccount;
  const lockNote = locked
    ? 'Switch the account on to change its details.'
    : selfAccount
      ? 'On your own account only the name can change, so you can never lock yourself out.'
      : undefined;
  const lockedDescribedBy = lockNote ? LOCK_NOTE_ID : undefined;

  return (
    // noValidate: the page's own checks give clearer messages than the browser's.
    <form noValidate onSubmit={submit} aria-busy={pending} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="account-name">Full name</Label>
        <Input
          id="account-name"
          required
          minLength={NAME_MIN_LENGTH}
          maxLength={NAME_MAX_LENGTH}
          autoComplete="off"
          disabled={locked}
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          aria-invalid={badField === 'fullName' || undefined}
          aria-describedby={describedBy('fullName') ?? (locked ? lockedDescribedBy : undefined)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="account-email">Email</Label>
        <Input
          id="account-email"
          type="email"
          required
          maxLength={EMAIL_MAX_LENGTH}
          autoComplete="off"
          disabled={fieldsLocked}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={badField === 'email' || undefined}
          aria-describedby={describedBy('email') ?? lockedDescribedBy}
        />
      </div>

      <SelectField
        id="account-role"
        label="Role"
        value={role}
        disabled={fieldsLocked}
        invalid={badField === 'role'}
        describedBy={describedBy('role') ?? lockedDescribedBy}
        onChange={(value) => {
          if (isUserRole(value)) {
            setRole(value);
          }
        }}
      >
        {ROLES.map((value) => (
          <option key={value} value={value}>
            {roleLabels[value]}
          </option>
        ))}
      </SelectField>

      {roleNeedsEmployee(role) && (
        <EmployeeSelect
          id="account-employee"
          label="Linked employee"
          value={employeeId}
          onChange={setEmployeeId}
          disabled={fieldsLocked}
          invalid={badField === 'employeeId'}
          describedBy={describedBy('employeeId') ?? lockedDescribedBy}
        />
      )}

      {lockNote && (
        <p id={LOCK_NOTE_ID} className="text-muted-foreground text-xs">
          {lockNote}
        </p>
      )}

      {mistake && (
        <Alert variant="destructive">
          <AlertDescription>{mistake}</AlertDescription>
        </Alert>
      )}

      {problem && (
        <Alert id={PROBLEM_ID} variant="destructive">
          <AlertTitle>Could not save the account</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
          </AlertDescription>
        </Alert>
      )}

      {!locked && (
        <div>
          <Button type="submit">{pending ? 'Saving…' : submitLabel}</Button>
        </div>
      )}
    </form>
  );
}
