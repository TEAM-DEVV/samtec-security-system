import type { PasswordSetup, UpdateUserRequest, UserAccount } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { routes } from '@/app/routes';
import { DetailRow } from '@/components/detail-row';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PasswordLinkPanel } from '@/components/password-link-panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAccountForm, type UserAccountValues } from '@/components/user-account-form';
import { UserStatusBadge, userStatusDescriptions } from '@/components/user-status-badge';
import { $api } from '@/lib/api';
import { formatDateTime, initials } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError, isProblemDetails } from '@/lib/problem';
import { roleLabels } from '@/lib/roles';
import { useSession } from '@/lib/session';

/**
 * One sign-in account (ADMIN only): change its details, switch it off or on,
 * or reset its sign-in. The API refuses the last three on the caller's own
 * account, so those buttons are not shown for it.
 */
export function UserDetailPage() {
  const { userId = '' } = useParams<{ userId: string }>();
  const account = $api.useQuery('get', '/users/{userId}', { params: { path: { userId } } });
  // Never the person's name: browser history on a shared computer must not reveal who was looked up.
  usePageTitle('Account');

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <Link
        to={routes.users}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Users
      </Link>

      {account.isError ? (
        <LoadError
          error={account.error}
          retrying={account.isFetching}
          onRetry={() => void account.refetch()}
        />
      ) : account.isPending ? (
        <LoadingAccount />
      ) : (
        <AccountRecord account={account.data} />
      )}
    </div>
  );
}

type SaveOutcome = 'saved' | 'nothing-to-save';

function AccountRecord({ account }: { account: UserAccount }) {
  const session = useSession();
  const queryClient = useQueryClient();
  // The person signed in is looking at their own account.
  const selfAccount = session?.user.id === account.id;
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome | null>(null);
  // Bumped only by this form's own save, so a refetch never throws away unsaved typing.
  const [formVersion, setFormVersion] = useState(0);
  const [freshLink, setFreshLink] = useState<PasswordSetup | null>(null);

  /** Reload this account and the list, so every screen shows the change. */
  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['get', '/users/{userId}'] });
    void queryClient.invalidateQueries({ queryKey: ['get', '/users'] });
  }

  const update = $api.useMutation('patch', '/users/{userId}', {
    onSuccess: () => {
      setSaveOutcome('saved');
      setFormVersion((version) => version + 1);
      refresh();
    },
  });
  const deactivate = $api.useMutation('post', '/users/{userId}/deactivate', {
    onSuccess: () => {
      // Switching off cancels any unused link, so stop showing it.
      setFreshLink(null);
      refresh();
    },
  });
  const reactivate = $api.useMutation('post', '/users/{userId}/reactivate', {
    onSuccess: refresh,
  });
  const reset = $api.useMutation('post', '/users/{userId}/reset-sign-in', {
    // The response holds the one-time token: forget it the moment this page closes.
    gcTime: 0,
    onSuccess: (result) => {
      setFreshLink(result.passwordSetup);
      refresh();
    },
  });

  function save(values: UserAccountValues) {
    // Send only what changed: the contract wants at least one field, and the
    // API refuses fields other than the name on your own account.
    const body: UpdateUserRequest = {};
    if (values.fullName !== account.fullName) body.fullName = values.fullName;
    if (values.email !== account.email) body.email = values.email;
    if (values.role !== account.role) body.role = values.role;
    if (values.employeeId !== account.employeeId) body.employeeId = values.employeeId;
    if (Object.keys(body).length === 0) {
      setSaveOutcome('nothing-to-save');
      return;
    }
    setSaveOutcome(null);
    update.mutate({ params: { path: { userId: account.id } }, body });
  }

  /** Forgets an earlier action's error before starting a new one, so only the latest result shows. */
  function startAction(run: () => void) {
    deactivate.reset();
    reactivate.reset();
    reset.reset();
    run();
  }

  const pathParams = { params: { path: { userId: account.id } } };
  const switchedOff = account.status === 'DEACTIVATED';
  const actionError = deactivate.error ?? reactivate.error ?? reset.error;
  const actionProblem = actionError ? describeApiError(actionError) : undefined;
  const actionPending = deactivate.isPending || reactivate.isPending || reset.isPending;

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-card/60 p-5 motion-safe:animate-rise-soft">
        <div className="flex items-center gap-4">
          <Avatar
            aria-hidden="true"
            className="size-16 ring-2 ring-gold/70 ring-offset-2 ring-offset-background"
          >
            <AvatarFallback className="bg-primary font-heading font-semibold text-primary-foreground text-xl">
              {initials(account.fullName)}
            </AvatarFallback>
          </Avatar>
          <div className="space-y-1">
            <h1 className="font-semibold text-3xl tracking-tight">{account.fullName}</h1>
            <p className="text-muted-foreground text-sm">
              {account.email} · {roleLabels[account.role]}
              {selfAccount && ' · this is you'}
            </p>
          </div>
        </div>
        <UserStatusBadge status={account.status} />
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="stagger-1 rounded-2xl motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="font-heading text-lg">Details</CardTitle>
            <CardDescription>
              Changing the role or the employee link signs the person out everywhere.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <UserAccountForm
              key={formVersion}
              initial={account}
              selfAccount={selfAccount}
              locked={switchedOff}
              submitLabel="Save changes"
              pending={update.isPending}
              error={update.error}
              onSubmit={save}
            />
            {saveOutcome && !update.isPending && (
              <p role="status" className="text-emerald-700 text-sm dark:text-emerald-400">
                {saveOutcome === 'saved' ? 'Saved.' : 'Nothing to save.'}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="stagger-2 rounded-2xl motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="font-heading text-lg">Sign-in</CardTitle>
            <CardDescription>{userStatusDescriptions[account.status]}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <DetailRow term="Two-factor">
                {account.twoFactorEnabled ? (
                  'On'
                ) : (
                  <span className="text-muted-foreground">Not set up</span>
                )}
              </DetailRow>
              <DetailRow term="Employee">
                {account.employeeId ? (
                  <Link
                    to={routes.employee(account.employeeId)}
                    className="text-primary underline underline-offset-4 hover:no-underline"
                  >
                    Open the employee record
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Not linked</span>
                )}
              </DetailRow>
              <DetailRow term="Created">
                <span className="tabular-nums">{formatDateTime(account.createdAt)}</span>
              </DetailRow>
              <DetailRow term="Last changed">
                <span className="tabular-nums">{formatDateTime(account.updatedAt)}</span>
              </DetailRow>
            </dl>

            {freshLink && <PasswordLinkPanel passwordSetup={freshLink} email={account.email} />}

            {selfAccount ? (
              <p className="text-muted-foreground text-xs">
                You cannot switch off or reset your own account. Ask another administrator.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {switchedOff ? (
                  <Button
                    variant="outline"
                    aria-disabled={actionPending}
                    onClick={() => {
                      if (!actionPending) startAction(() => reactivate.mutate(pathParams));
                    }}
                  >
                    {reactivate.isPending ? 'Switching on…' : 'Switch on'}
                  </Button>
                ) : (
                  <>
                    <ConfirmButton
                      label={deactivate.isPending ? 'Switching off…' : 'Switch off'}
                      title={`Switch off ${account.fullName}'s account?`}
                      description="They can no longer sign in, and every session ends now. Nothing is deleted; you can switch it back on later."
                      confirmLabel="Switch off"
                      pending={actionPending}
                      onConfirm={() => startAction(() => deactivate.mutate(pathParams))}
                    />
                    <ConfirmButton
                      label={reset.isPending ? 'Resetting…' : 'Reset sign-in'}
                      title={`Reset ${account.fullName}'s sign-in?`}
                      description="Clears the password and the authenticator, ends every session, and gives you a new one-time link to send them."
                      confirmLabel="Reset sign-in"
                      pending={actionPending}
                      onConfirm={() => startAction(() => reset.mutate(pathParams))}
                    />
                  </>
                )}
              </div>
            )}

            {actionProblem && (
              <Alert variant="destructive">
                <AlertTitle>That did not work</AlertTitle>
                <AlertDescription>
                  <p>{actionProblem.message}</p>
                  {actionProblem.traceId && (
                    <p className="font-mono text-xs">Trace ID: {actionProblem.traceId}</p>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

interface ConfirmButtonProps {
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
}

/** A button that asks "are you sure?" before doing something the person cannot undo by themselves. */
function ConfirmButton({
  label,
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
}: ConfirmButtonProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" aria-disabled={pending}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (!pending) onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function LoadingAccount() {
  return (
    <div className="grid gap-4">
      <span role="status" className="sr-only">
        Loading account…
      </span>
      <Skeleton aria-hidden="true" className="h-24 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton aria-hidden="true" className="h-72 w-full" />
        <Skeleton aria-hidden="true" className="h-72 w-full" />
      </div>
    </div>
  );
}

interface LoadErrorProps {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}

/** A 404 gets its own wording, so the page says only that nothing was found. */
function LoadError({ error, retrying, onRetry }: LoadErrorProps) {
  if (isProblemDetails(error) && error.status === 404) {
    return (
      <Alert>
        <AlertTitle>No account found</AlertTitle>
        <AlertDescription>
          <p>There is no sign-in account with this ID.</p>
          <p className="font-mono text-xs">Trace ID: {error.traceId}</p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <LoadErrorAlert
      title="The account could not be loaded"
      error={error}
      retrying={retrying}
      onRetry={onRetry}
    />
  );
}
