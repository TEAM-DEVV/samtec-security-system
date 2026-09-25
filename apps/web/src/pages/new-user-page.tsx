import type { UserAccountWithPasswordSetup } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { PageHeader } from '@/components/page-header';
import { PasswordLinkPanel } from '@/components/password-link-panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UserAccountForm, type UserAccountValues } from '@/components/user-account-form';
import { userStatusDescriptions } from '@/components/user-status-badge';
import { $api } from '@/lib/api';
import { usePageTitle } from '@/lib/page-title';
import { roleLabels } from '@/lib/roles';

/**
 * Creates a sign-in account (ADMIN only). The API answers with the account
 * and a one-time password link, shown only in that one response, so this
 * page shows the link straight away instead of moving on.
 */
export function NewUserPage() {
  usePageTitle('Add account');
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<UserAccountWithPasswordSetup | null>(null);

  const create = $api.useMutation('post', '/users', {
    // The response holds the one-time token: forget it the moment this page closes.
    gcTime: 0,
    onSuccess: (result) => {
      setCreated(result);
      // The list is out of date now; reload it next time it is shown.
      void queryClient.invalidateQueries({ queryKey: ['get', '/users'] });
    },
  });

  function submit(values: UserAccountValues) {
    create.mutate({
      body: {
        email: values.email,
        fullName: values.fullName,
        role: values.role,
        // The contract wants the field left out, not `null`, for roles without a link.
        ...(values.employeeId !== null && { employeeId: values.employeeId }),
      },
    });
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Link
        to={routes.users}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Users
      </Link>

      {created ? (
        <>
          <PageHeader eyebrow="Administration" title="Account created" />
          <Card className="rounded-2xl motion-safe:animate-rise-soft">
            <CardHeader>
              <CardTitle className="font-heading text-lg">{created.user.fullName}</CardTitle>
              <CardDescription>
                {created.user.email} · {roleLabels[created.user.role]}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {created.user.status === 'AWAITING_CONFIRMATION' ? (
                <Alert>
                  <AlertTitle>The link is not enough on its own</AlertTitle>
                  <AlertDescription>
                    {userStatusDescriptions.AWAITING_CONFIRMATION} Open the account and use “Confirm
                    this administrator” — and it cannot be you.
                  </AlertDescription>
                </Alert>
              ) : null}
              <PasswordLinkPanel passwordSetup={created.passwordSetup} email={created.user.email} />
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link to={routes.user(created.user.id)}>Open the account</Link>
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    create.reset();
                    setCreated(null);
                  }}
                >
                  Add another
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          <PageHeader
            eyebrow="Administration"
            title="Add account"
            description="The person chooses their own password with a one-time link. Nobody at SAMTEC ever sees it."
          />
          <Card className="rounded-2xl motion-safe:animate-rise-soft">
            <CardContent>
              <UserAccountForm
                submitLabel="Create account"
                pending={create.isPending}
                error={create.error}
                onSubmit={submit}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
