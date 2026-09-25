import type { Employee } from '@samtec/contracts';
import { type FormEvent, useState } from 'react';
import { NO_POSTING, type Posting, PostingFields } from '@/components/posting-fields';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { todayInGhana } from '@/lib/format';
import { describeApiError, isProblemDetails } from '@/lib/problem';

// The contract's limits (`CreateEmployeeRequest`, `PersonName`).
const NAME_MAX_LENGTH = 60;
const POSITION_MIN_LENGTH = 2;
const POSITION_MAX_LENGTH = 60;
const EMAIL_MAX_LENGTH = 254;
/** The same shapes the API checks. Checking here only saves a round trip. */
const GHANA_PHONE = /^\+233\d{9}$/;
const GHANA_CARD = /^GHA-\d{9}-\d$/;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;

/** Ids that link a field to the text explaining it, for screen readers. */
const PROBLEM_ID = 'employee-form-problem';

/** What the form collects. Every text field is already trimmed. */
export interface EmployeeValues {
  firstName: string;
  lastName: string;
  otherNames: string;
  phone: string;
  email: string;
  ghanaCardNumber: string;
  position: string;
  hireDate: string;
  posting: Posting;
}

interface EmployeeFormProps {
  /** The employee being changed. Leave it out to register a new one. */
  initial?: Employee;
  submitLabel: string;
  pending: boolean;
  /** The last failed request, if any. */
  error: unknown;
  onSubmit: (values: EmployeeValues) => void;
}

/**
 * The fields of an employee record, shared by "Add employee" and "Edit
 * employee".
 *
 * Two fields exist only when registering somebody: the **Ghana Card number**,
 * because it is how a person is identified for life and the API has no way to
 * change it, and the **hire date**, because an employment period has already
 * started and moving its beginning would move attendance and pay that are
 * already recorded. Both are shown read-only when editing, so nobody has to
 * wonder where they went.
 *
 * The API checks all of this again. These checks only catch the obvious before
 * a request is sent.
 */
export function EmployeeForm({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
}: EmployeeFormProps) {
  const editing = initial !== undefined;
  const [firstName, setFirstName] = useState(initial?.firstName ?? '');
  const [lastName, setLastName] = useState(initial?.lastName ?? '');
  const [otherNames, setOtherNames] = useState(initial?.otherNames ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '+233');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [ghanaCardNumber, setGhanaCardNumber] = useState(initial?.ghanaCardNumber ?? '');
  const [position, setPosition] = useState(initial?.position ?? '');
  const [hireDate, setHireDate] = useState(initial?.hireDate ?? todayInGhana);
  const [posting, setPosting] = useState<Posting>(
    initial
      ? {
          siteId: initial.currentSite?.id ?? '',
          postId: initial.currentPost?.id ?? '',
          shiftPatternId: initial.currentShiftPattern?.id ?? '',
        }
      : NO_POSTING,
  );
  const [mistake, setMistake] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    const values: EmployeeValues = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      otherNames: otherNames.trim(),
      phone: phone.trim(),
      email: email.trim(),
      ghanaCardNumber: ghanaCardNumber.trim().toUpperCase(),
      position: position.trim(),
      hireDate,
      posting,
    };

    if (values.firstName === '' || values.lastName === '') {
      setMistake('A first name and a last name are both needed.');
      return;
    }
    if (!GHANA_PHONE.test(values.phone)) {
      setMistake('The phone number must be +233 followed by 9 digits, like +233241234567.');
      return;
    }
    if (values.email !== '' && !EMAIL_SHAPE.test(values.email)) {
      setMistake('Enter a valid email address, or leave the box empty.');
      return;
    }
    if (!editing && !GHANA_CARD.test(values.ghanaCardNumber)) {
      setMistake('The Ghana Card number must look like GHA-123456789-0.');
      return;
    }
    if (values.position.length < POSITION_MIN_LENGTH) {
      setMistake(`The position needs at least ${POSITION_MIN_LENGTH} characters.`);
      return;
    }
    if (!editing && values.hireDate === '') {
      setMistake('Choose the date this person started.');
      return;
    }
    setMistake(null);
    onSubmit(values);
  }

  const badField = isProblemDetails(error) ? error.errors?.[0]?.path : undefined;
  const problem = error ? describeApiError(error) : undefined;
  const describedBy = (field: string) => (badField === field ? PROBLEM_ID : undefined);

  return (
    // noValidate: the form's own messages are clearer than the browser's.
    <form noValidate onSubmit={submit} aria-busy={pending} className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="employee-first-name">First name</Label>
          <Input
            id="employee-first-name"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            aria-invalid={badField === 'firstName' || undefined}
            aria-describedby={describedBy('firstName')}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="employee-last-name">Last name</Label>
          <Input
            id="employee-last-name"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            aria-invalid={badField === 'lastName' || undefined}
            aria-describedby={describedBy('lastName')}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="employee-other-names">Other names (optional)</Label>
        <Input
          id="employee-other-names"
          maxLength={NAME_MAX_LENGTH}
          autoComplete="off"
          value={otherNames}
          onChange={(event) => setOtherNames(event.target.value)}
          aria-invalid={badField === 'otherNames' || undefined}
          aria-describedby={describedBy('otherNames')}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="employee-phone">Phone</Label>
          <Input
            id="employee-phone"
            required
            inputMode="tel"
            autoComplete="off"
            placeholder="+233241234567"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            aria-invalid={badField === 'phone' || undefined}
            aria-describedby={describedBy('phone')}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="employee-email">Email (optional)</Label>
          <Input
            id="employee-email"
            type="email"
            maxLength={EMAIL_MAX_LENGTH}
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={badField === 'email' || undefined}
            aria-describedby={describedBy('email')}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="employee-position">Position</Label>
        <Input
          id="employee-position"
          required
          minLength={POSITION_MIN_LENGTH}
          maxLength={POSITION_MAX_LENGTH}
          autoComplete="off"
          placeholder="Security Guard"
          value={position}
          onChange={(event) => setPosition(event.target.value)}
          aria-invalid={badField === 'position' || undefined}
          aria-describedby={describedBy('position')}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="employee-ghana-card">Ghana Card number</Label>
          <Input
            id="employee-ghana-card"
            required={!editing}
            readOnly={editing}
            autoComplete="off"
            placeholder="GHA-123456789-0"
            value={ghanaCardNumber}
            onChange={(event) => setGhanaCardNumber(event.target.value)}
            aria-invalid={badField === 'ghanaCardNumber' || undefined}
            aria-describedby={
              describedBy('ghanaCardNumber') ?? (editing ? 'employee-fixed-note' : undefined)
            }
            className={editing ? 'font-mono text-muted-foreground' : 'font-mono'}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="employee-hire-date">Started on</Label>
          <Input
            id="employee-hire-date"
            type="date"
            required={!editing}
            readOnly={editing}
            value={hireDate}
            onChange={(event) => setHireDate(event.target.value)}
            aria-invalid={badField === 'hireDate' || undefined}
            aria-describedby={
              describedBy('hireDate') ?? (editing ? 'employee-fixed-note' : undefined)
            }
            className={editing ? 'text-muted-foreground' : undefined}
          />
        </div>
      </div>

      {editing && (
        <p id="employee-fixed-note" className="text-muted-foreground text-xs">
          The Ghana Card number and the start date cannot be changed here. The card number
          identifies this person for life, and the start date is already tied to the attendance and
          the pay recorded since.
        </p>
      )}

      <PostingFields
        value={posting}
        onChange={setPosting}
        disabled={pending}
        badField={badField}
        describedBy={PROBLEM_ID}
      />

      {mistake && (
        <Alert variant="destructive">
          <AlertDescription>{mistake}</AlertDescription>
        </Alert>
      )}

      {problem && (
        <Alert id={PROBLEM_ID} variant="destructive">
          <AlertTitle>Could not save the employee</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
          </AlertDescription>
        </Alert>
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
