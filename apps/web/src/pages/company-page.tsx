import type { CompanyBankAccount, SetCompanyBankAccountRequest } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError } from '@/lib/problem';

const TEXT_MIN = 2;
const TEXT_MAX = 100;
const ACCOUNT_NUMBER_SHAPE = /^[0-9]{5,20}$/;

/**
 * The company's own record (ADMIN only): its name, and the bank account its
 * payroll is paid from.
 *
 * There is no `GET` anywhere in the API that returns a full account number —
 * this screen's own `GET` shows only the last four digits, the same trap
 * `payroll/README.md` describes for an employee's payment details. So this
 * form never pre-fills the account number: it is always typed fresh, and
 * leaving it blank is treated as "remove it", with a confirmation step before
 * that actually happens, so a save made to fix the bank name alone cannot
 * silently wipe the account number nobody meant to touch.
 */
export function CompanyPage() {
  usePageTitle('Company');
  const bankAccount = $api.useQuery('get', '/company/bank-account');

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Company"
        description="The company's name and the bank account its payroll is paid from."
      />

      {bankAccount.isError ? (
        <LoadErrorAlert
          title="The company's bank account could not be loaded"
          error={bankAccount.error}
          onRetry={() => void bankAccount.refetch()}
          retrying={bankAccount.isFetching}
        />
      ) : bankAccount.isPending ? (
        <LoadingCard />
      ) : (
        <BankAccountCard account={bankAccount.data} />
      )}
    </div>
  );
}

function LoadingCard() {
  return (
    <Card>
      <CardContent className="pt-6">
        <span role="status" className="sr-only">
          Loading the company's bank account…
        </span>
        <Skeleton aria-hidden="true" className="h-72 w-full" />
      </CardContent>
    </Card>
  );
}

function BankAccountCard({ account }: { account: CompanyBankAccount }) {
  const queryClient = useQueryClient();
  const save = $api.useMutation('put', '/company/bank-account', {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['get', '/company/bank-account'] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-heading text-lg">{account.companyName}</CardTitle>
        <CardDescription>
          The monthly bank file, and the company's own payment receipt once salaries are paid, are
          both drawn from this account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <BankAccountForm
          // A fresh form after every successful save, so a stale "remove it"
          // confirmation from one attempt never carries into the next.
          key={`${account.bankName}|${account.branch}|${account.accountName}|${account.accountNumberMasked}`}
          account={account}
          pending={save.isPending}
          error={save.error}
          saved={save.isSuccess}
          onSubmit={(body) => {
            save.reset();
            save.mutate({ body });
          }}
        />
      </CardContent>
    </Card>
  );
}

interface BankAccountFormProps {
  account: CompanyBankAccount;
  pending: boolean;
  error: unknown;
  saved: boolean;
  onSubmit: (body: SetCompanyBankAccountRequest) => void;
}

function BankAccountForm({ account, pending, error, saved, onSubmit }: BankAccountFormProps) {
  const [bankName, setBankName] = useState(account.bankName ?? '');
  const [branch, setBranch] = useState(account.branch ?? '');
  const [accountName, setAccountName] = useState(account.accountName ?? '');
  // Never pre-filled: the API never hands back a full account number.
  const [accountNumber, setAccountNumber] = useState('');
  const [mistake, setMistake] = useState<string | null>(null);
  // Set once an empty account number has been explained and accepted, so the
  // confirmation only has to be shown once per attempt to clear it.
  const [confirmedClear, setConfirmedClear] = useState(false);

  /** `null` when empty, the trimmed text otherwise, or undefined when it fails the shape check. */
  function optionalText(
    value: string,
    label: string,
    low: number,
    high: number,
  ): string | null | undefined {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (trimmed.length < low || trimmed.length > high) {
      setMistake(`${label} needs ${low} to ${high} characters, or leave it blank.`);
      return undefined;
    }
    return trimmed;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setMistake(null);

    const bankNameValue = optionalText(bankName, 'Bank name', TEXT_MIN, TEXT_MAX);
    if (bankNameValue === undefined) return;
    const branchValue = optionalText(branch, 'Branch', TEXT_MIN, TEXT_MAX);
    if (branchValue === undefined) return;
    const accountNameValue = optionalText(accountName, 'Account name', TEXT_MIN, TEXT_MAX);
    if (accountNameValue === undefined) return;

    const trimmedNumber = accountNumber.trim();
    if (trimmedNumber !== '' && !ACCOUNT_NUMBER_SHAPE.test(trimmedNumber)) {
      setMistake('Account number must be 5 to 20 digits, with nothing else.');
      return;
    }
    if (trimmedNumber === '' && account.accountNumberMasked !== null && !confirmedClear) {
      setMistake(
        'This would remove the saved account number. Type it again to keep it, or confirm removing it below.',
      );
      return;
    }

    onSubmit({
      bankName: bankNameValue,
      branch: branchValue,
      accountName: accountNameValue,
      accountNumber: trimmedNumber === '' ? null : trimmedNumber,
    });
    setConfirmedClear(false);
  }

  const showRemoveConfirm =
    accountNumber.trim() === '' && account.accountNumberMasked !== null && !confirmedClear;
  const problem = error ? describeApiError(error) : undefined;

  return (
    <form noValidate onSubmit={submit} aria-busy={pending} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="bank-name">Bank name</Label>
        <Input
          id="bank-name"
          value={bankName}
          placeholder="e.g. Akwaaba Bank"
          onChange={(event) => setBankName(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="bank-branch">Branch</Label>
        <Input
          id="bank-branch"
          value={branch}
          placeholder="e.g. Ridge"
          onChange={(event) => setBranch(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="account-name">Account name</Label>
        <Input
          id="account-name"
          value={accountName}
          placeholder="The name on the account"
          onChange={(event) => setAccountName(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="account-number">Account number</Label>
        <Input
          id="account-number"
          inputMode="numeric"
          value={accountNumber}
          placeholder="e.g. 1234567890123"
          onChange={(event) => {
            setAccountNumber(event.target.value);
            setConfirmedClear(false);
          }}
          aria-describedby="account-number-hint"
        />
        <p id="account-number-hint" className="text-muted-foreground text-xs">
          Currently on file:{' '}
          {account.accountNumberMasked === null ? 'no account number' : account.accountNumberMasked}
          . For security the saved number is never shown in full, so type it again to keep it, or
          leave this blank to remove it.
        </p>
      </div>

      {showRemoveConfirm && (
        <Alert>
          <AlertTitle>Remove the saved account number?</AlertTitle>
          <AlertDescription>
            <p>
              The account number field is blank, which will take {account.accountNumberMasked} off
              the account. If that is a mistake, type the number again instead.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                setMistake(null);
                setConfirmedClear(true);
              }}
            >
              Remove the account number
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {mistake && (
        <Alert variant="destructive">
          <AlertDescription>{mistake}</AlertDescription>
        </Alert>
      )}
      {problem && (
        <Alert variant="destructive">
          <AlertTitle>Could not save the bank account</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
        {saved && !pending && !error && (
          <p role="status" className="text-emerald-700 text-sm dark:text-emerald-400">
            Saved.
          </p>
        )}
      </div>
    </form>
  );
}
