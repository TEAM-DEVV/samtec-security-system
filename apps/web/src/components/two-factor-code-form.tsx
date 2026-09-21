import { type FormEvent, useState } from 'react';
import { StartOverLink } from '@/components/start-over-link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { describeApiError } from '@/lib/problem';

/** The contract's `TwoFactorCode`: exactly six digits. */
const CODE_PATTERN = /^\d{6}$/;

interface TwoFactorCodeFormProps {
  /** Text on the submit button, for example "Verify code". */
  submitLabel: string;
  /** True while the request is running. */
  pending: boolean;
  /** The last failed request, if any. */
  error: unknown;
  onSubmit: (code: string) => void;
}

/**
 * The 6-digit code box shared by the two-factor screens. The code is checked
 * on the page before it is sent, so a typo never costs one of the five tries
 * the API allows.
 */
export function TwoFactorCodeForm({
  submitLabel,
  pending,
  error,
  onSubmit,
}: TwoFactorCodeFormProps) {
  const [code, setCode] = useState('');
  const [codeInvalid, setCodeInvalid] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    const trimmed = code.trim();
    if (!CODE_PATTERN.test(trimmed)) {
      setCodeInvalid(true);
      return;
    }
    setCodeInvalid(false);
    onSubmit(trimmed);
  }

  const problem = error ? describeApiError(error) : undefined;

  return (
    <form onSubmit={submit} aria-busy={pending} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="two-factor-code">6-digit code</Label>
        <Input
          id="two-factor-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            // Typing a correction clears the "must be 6 digits" warning.
            setCodeInvalid(false);
          }}
          aria-invalid={codeInvalid}
          aria-describedby="two-factor-code-hint"
          className="text-center font-mono text-lg tracking-[0.4em]"
        />
        <p
          id="two-factor-code-hint"
          className={codeInvalid ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
        >
          {codeInvalid
            ? 'The code must be exactly 6 digits.'
            : 'Enter the 6 digits shown in your authenticator app.'}
        </p>
      </div>

      {problem && (
        <Alert variant="destructive">
          <AlertTitle>Could not continue</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
          </AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full">
        {pending ? 'Checking…' : submitLabel}
      </Button>

      <StartOverLink />
    </form>
  );
}
