import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchClient } from '@/lib/api';
import { setPasswordConfirmationAsker } from '@/lib/password-confirmation';
import { describeApiError } from '@/lib/problem';
import { updateAccessToken } from '@/lib/session';

/**
 * The one "Confirm with your password" dialog, mounted once for the whole
 * dashboard. It never opens by itself: the API client opens it when a
 * sensitive action was refused with `PASSWORD_CONFIRMATION_REQUIRED`, waits
 * for the answer, and sends the action again. A right password swaps in the
 * access token the API hands back, which carries the confirmation for five
 * minutes; giving up leaves the action refused, and the page shows that.
 */
export function PasswordConfirmationDialog() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Settles the promise the API client is waiting on. */
  const settle = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(() => {
    setPasswordConfirmationAsker(
      () =>
        new Promise<boolean>((resolve) => {
          settle.current = resolve;
          setPassword('');
          setProblem(null);
          setOpen(true);
        }),
    );
    return () => setPasswordConfirmationAsker(null);
  }, []);

  function finish(confirmed: boolean) {
    setOpen(false);
    setPending(false);
    settle.current?.(confirmed);
    settle.current = null;
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (password.length === 0) {
      setProblem('Enter your password.');
      return;
    }
    setPending(true);
    setProblem(null);
    const { data, error } = await fetchClient.POST('/auth/confirm-password', {
      body: { password },
    });
    if (data) {
      updateAccessToken(data.accessToken);
      finish(true);
      return;
    }
    setPending(false);
    setProblem(describeApiError(error).message);
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) finish(false);
      }}
    >
      <AlertDialogContent>
        <form onSubmit={confirm} className="grid gap-4" noValidate>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm with your password</AlertDialogTitle>
            <AlertDialogDescription>
              This is a sensitive action. Enter your own password to go ahead. You will not be asked
              again for five minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="password-confirmation">Password</Label>
            <Input
              id="password-confirmation"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {problem && (
            <Alert variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(false)}>
              Cancel
            </Button>
            <Button type="submit" aria-disabled={pending}>
              {pending ? 'Checking…' : 'Confirm'}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
