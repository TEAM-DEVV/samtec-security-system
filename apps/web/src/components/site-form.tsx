import type { GhanaRegion, Site, SiteStatus } from '@samtec/contracts';
import { type FormEvent, useState } from 'react';
import { SelectField } from '@/components/select-field';
import { SITE_STATUSES, siteStatusLabels } from '@/components/site-status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GHANA_REGIONS, isGhanaRegion, regionLabels } from '@/lib/ghana-regions';
import { describeApiError, isProblemDetails } from '@/lib/problem';

// The contract's limits (`CreateSiteRequest`).
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 120;
const CLIENT_NAME_MIN_LENGTH = 2;
const CLIENT_NAME_MAX_LENGTH = 120;
const CITY_MIN_LENGTH = 2;
const CITY_MAX_LENGTH = 60;
/** The same shape the API checks. Checking here only saves a round trip. */
const SITE_CODE = /^[A-Z]{3}-\d{2}$/;

/** Ids that link a field to the text explaining it, for screen readers. */
const PROBLEM_ID = 'site-form-problem';

/** What the form collects. Every text field is already trimmed. */
export interface SiteValues {
  code: string;
  name: string;
  clientName: string;
  region: GhanaRegion | '';
  city: string;
  status: SiteStatus;
}

interface SiteFormProps {
  /** The site being changed. Leave it out to add a new one. */
  initial?: Site;
  submitLabel: string;
  pending: boolean;
  /** The last failed request, if any. */
  error: unknown;
  onSubmit: (values: SiteValues) => void;
}

/**
 * The fields of a site record, shared by "Add site" and "Edit site".
 *
 * The **code** only exists when adding a site: it is printed on devices and
 * documents, so the API never lets it change, and this form shows it
 * read-only once a site exists rather than leaving people to wonder where it
 * went.
 *
 * The API checks all of this again. These checks only catch the obvious
 * before a request is sent.
 */
export function SiteForm({ initial, submitLabel, pending, error, onSubmit }: SiteFormProps) {
  const editing = initial !== undefined;
  const [code, setCode] = useState(initial?.code ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [clientName, setClientName] = useState(initial?.clientName ?? '');
  const [region, setRegion] = useState<GhanaRegion | ''>(initial?.region ?? '');
  const [city, setCity] = useState(initial?.city ?? '');
  const [status, setStatus] = useState<SiteStatus>(initial?.status ?? 'ACTIVE');
  const [mistake, setMistake] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    const values = {
      code: code.trim().toUpperCase(),
      name: name.trim(),
      clientName: clientName.trim(),
      region,
      city: city.trim(),
      status,
    };

    if (!editing && !SITE_CODE.test(values.code)) {
      setMistake('The code must look like ACC-01: three capital letters, a dash, two digits.');
      return;
    }
    if (values.name.length < NAME_MIN_LENGTH) {
      setMistake(`The name needs at least ${NAME_MIN_LENGTH} characters.`);
      return;
    }
    if (values.clientName.length < CLIENT_NAME_MIN_LENGTH) {
      setMistake(`The client name needs at least ${CLIENT_NAME_MIN_LENGTH} characters.`);
      return;
    }
    if (values.region === '') {
      setMistake('Choose a region.');
      return;
    }
    if (values.city.length < CITY_MIN_LENGTH) {
      setMistake(`The city needs at least ${CITY_MIN_LENGTH} characters.`);
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
      <div className="grid gap-1.5">
        <Label htmlFor="site-code">Code</Label>
        <Input
          id="site-code"
          required={!editing}
          readOnly={editing}
          autoComplete="off"
          placeholder="ACC-01"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-invalid={badField === 'code' || undefined}
          aria-describedby={describedBy('code') ?? (editing ? 'site-code-fixed-note' : undefined)}
          className={editing ? 'font-mono text-muted-foreground' : 'font-mono'}
        />
        {editing && (
          <p id="site-code-fixed-note" className="text-muted-foreground text-xs">
            The code cannot be changed here: it is printed on devices and documents.
          </p>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="site-name">Name</Label>
        <Input
          id="site-name"
          required
          minLength={NAME_MIN_LENGTH}
          maxLength={NAME_MAX_LENGTH}
          autoComplete="off"
          placeholder="Ridge Towers Office Complex"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={badField === 'name' || undefined}
          aria-describedby={describedBy('name')}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="site-client-name">Client name</Label>
        <Input
          id="site-client-name"
          required
          minLength={CLIENT_NAME_MIN_LENGTH}
          maxLength={CLIENT_NAME_MAX_LENGTH}
          autoComplete="off"
          placeholder="Ridge Towers Management Ltd"
          value={clientName}
          onChange={(event) => setClientName(event.target.value)}
          aria-invalid={badField === 'clientName' || undefined}
          aria-describedby={describedBy('clientName')}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="site-region"
          label="Region"
          value={region}
          invalid={badField === 'region'}
          describedBy={describedBy('region')}
          onChange={(value) => setRegion(isGhanaRegion(value) ? value : '')}
        >
          <option value="" disabled>
            Choose a region
          </option>
          {GHANA_REGIONS.map((value) => (
            <option key={value} value={value}>
              {regionLabels[value]}
            </option>
          ))}
        </SelectField>

        <div className="grid gap-1.5">
          <Label htmlFor="site-city">City</Label>
          <Input
            id="site-city"
            required
            minLength={CITY_MIN_LENGTH}
            maxLength={CITY_MAX_LENGTH}
            autoComplete="off"
            placeholder="Accra"
            value={city}
            onChange={(event) => setCity(event.target.value)}
            aria-invalid={badField === 'city' || undefined}
            aria-describedby={describedBy('city')}
          />
        </div>
      </div>

      <SelectField
        id="site-status"
        label="Status"
        value={status}
        invalid={badField === 'status'}
        describedBy={describedBy('status')}
        onChange={(value) => setStatus(value === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE')}
      >
        {SITE_STATUSES.map((value) => (
          <option key={value} value={value}>
            {siteStatusLabels[value]}
          </option>
        ))}
      </SelectField>

      {mistake && (
        <Alert variant="destructive">
          <AlertDescription>{mistake}</AlertDescription>
        </Alert>
      )}

      {problem && (
        <Alert id={PROBLEM_ID} variant="destructive">
          <AlertTitle>Could not save the site</AlertTitle>
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
