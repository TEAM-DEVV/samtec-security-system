import { type FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { routes } from '@/app/routes';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchClient } from '@/lib/api';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError } from '@/lib/problem';
import { clearSession } from '@/lib/session';

// The contract's rule for a new password (`NewPassword`).
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

/** What the sign-in page says after the change. */
export const PASSWORD_CHANGED_NOTICE = 'Your password is changed. Sign in with the new one.';

/**
 * Where a signed-in person changes their own password. On success the API
 * ends every session of the account, including this one, so the page forgets
 * the session here too and sends the person to sign in again.
 *
 * The request goes straight through `fetchClient`, not a cached mutation, so
 * no data cache ever holds a password.
 */
export function ChangePasswordPage() {
  usePageTitle('Change password');
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeated, setRepeated] = useState('');
  const [mistake, setMistake] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ message: string; traceId?: string } | null>(null);
  const [sending, setSending] = useState(false);
  // Set straight away on submit, so a quick double click can never send twice.
  const inFlight = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) {
      return;
    }
    if (next.length < PASSWORD_MIN_LENGTH) {
      setMistake(`Use at least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`);
      return;
    }
    if (next.length > PASSWORD_MAX_LENGTH) {
      setMistake(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
      return;
    }
    if (next === current) {
      setMistake('Choose a password different from your current one.');
      return;
    }
    if (next !== repeated) {
      setMistake('The two new passwords are not the same. Type them again.');
      return;
    }
    setMistake(null);
    setProblem(null);
    inFlight.current = true;
    setSending(true);
    try {
      const { error, response } = await fetchClient.POST('/auth/change-password', {
        body: { currentPassword: current, newPassword: next },
      });
      // Judge by the status: an error from a proxy may come with no body at all.
      if (!response.ok) {
        setProblem(describeApiError(error));
        return;
      }
      // The password is saved and every session has ended: forget what was
      // typed and the session here, then explain on the sign-in page.
      setCurrent('');
      setNext('');
      setRepeated('');
      clearSession();
      navigate(routes.login, { replace: true, state: { notice: PASSWORD_CHANGED_NOTICE } });
    } catch (failure) {
      setProblem(describeApiError(failure));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6">
      <PageHeader
        eyebrow="Your account"
        title="Change password"
        description="Only you will know it. Nobody at SAMTEC can see it. Afterwards you sign in again everywhere."
      />

      <Card className="rounded-2xl motion-safe:animate-rise-soft">
        <CardContent>
          {/* noValidate: the page's own checks below give clearer messages than the browser's. */}
          <form noValidate onSubmit={submit} aria-busy={sending} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={PASSWORD_MAX_LENGTH}
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                aria-describedby="new-password-rule"
                value={next}
                onChange={(event) => setNext(event.target.value)}
              />
              <p id="new-password-rule" className="text-muted-foreground text-xs">
                At least {PASSWORD_MIN_LENGTH} characters. A short sentence is easy to remember and
                hard to guess.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="repeat-password">Type the new password again</Label>
              <Input
                id="repeat-password"
                type="password"
                autoComplete="new-password"
                required
                maxLength={PASSWORD_MAX_LENGTH}
                value={repeated}
                onChange={(event) => setRepeated(event.target.value)}
              />
            </div>

            {mistake && (
              <Alert variant="destructive">
                <AlertDescription>{mistake}</AlertDescription>
              </Alert>
            )}

            {problem && (
              <Alert variant="destructive">
                <AlertTitle>Could not change your password</AlertTitle>
                <AlertDescription>
                  <p>{problem.message}</p>
                  {problem.traceId && (
                    <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {/* aria-disabled, not disabled: a disabled button would drop the keyboard focus. */}
            <div>
              <Button type="submit" aria-disabled={sending}>
                {sending ? 'Saving…' : 'Change password'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
