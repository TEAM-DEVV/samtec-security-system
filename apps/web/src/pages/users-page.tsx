import type { UserAccountList } from '@samtec/contracts';
import { cn } from 'cn';
import { UserCog, UserPlus } from 'lucide-react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { TableEmptyRow, TableLoadingRows } from '@/components/table-states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { UserStatusBadge } from '@/components/user-status-badge';
import { $api } from '@/lib/api';
import { useCursorPages } from '@/lib/cursor-pages';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { roleLabels } from '@/lib/roles';

const PAGE_SIZE = 10;
const COLUMN_COUNT = 6;

/**
 * Every sign-in account of the company (ADMIN only), oldest first, with
 * cursor pagination. Same shape as the Employees page.
 */
export function UsersPage() {
  usePageTitle('Users');
  const pages = useCursorPages();

  const users = $api.useQuery(
    'get',
    '/users',
    { params: { query: { limit: PAGE_SIZE, cursor: pages.cursor } } },
    // Keep showing the current page while the next one loads.
    { placeholderData: (previous) => previous },
  );

  const showingOldPage = users.isPlaceholderData;
  // No Next under an error alert: the kept placeholder data may still hold a bookmark.
  const nextCursor = users.error ? null : (users.data?.nextCursor ?? null);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Users"
        description="Sign-in accounts: who can open the dashboard, and with which role."
        actions={
          <Button asChild>
            <Link to={routes.newUser}>
              <UserPlus aria-hidden="true" />
              Add account
            </Link>
          </Button>
        }
      />

      {users.error ? (
        <LoadErrorAlert
          title="Users could not be loaded"
          error={users.error}
          retrying={users.isFetching}
          onRetry={() => void users.refetch()}
        />
      ) : (
        <Card
          aria-busy={showingOldPage}
          className={cn(
            'overflow-hidden rounded-2xl py-0 transition-opacity motion-safe:animate-rise-soft',
            showingOldPage && 'opacity-60',
          )}
        >
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50 [&_th]:text-[11px] [&_th]:text-muted-foreground [&_th]:uppercase [&_th]:tracking-[0.14em]">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Two-factor</TableHead>
                <TableHead className="pr-4">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <UserRows loading={users.isPending} page={users.data} />
            </TableBody>
          </Table>
        </Card>
      )}

      <PaginationNav pages={pages} nextCursor={nextCursor} busy={showingOldPage} />
    </div>
  );
}

function UserRows({ loading, page }: { loading: boolean; page: UserAccountList | undefined }) {
  if (loading) {
    return <TableLoadingRows colSpan={COLUMN_COUNT} label="Loading users…" />;
  }

  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow
        colSpan={COLUMN_COUNT}
        icon={UserCog}
        title="No sign-in accounts yet."
        hint="Add one, and send the person their one-time link."
      />
    );
  }

  return page.items.map((account) => (
    <TableRow key={account.id}>
      <TableCell className="pl-4 font-medium">
        <Link
          to={routes.user(account.id)}
          className="text-primary underline underline-offset-4 hover:no-underline"
        >
          {account.fullName}
        </Link>
      </TableCell>
      <TableCell>{account.email}</TableCell>
      <TableCell>{roleLabels[account.role]}</TableCell>
      <TableCell>
        <UserStatusBadge status={account.status} />
      </TableCell>
      <TableCell>
        {account.twoFactorEnabled ? 'On' : <span className="text-muted-foreground">Off</span>}
      </TableCell>
      <TableCell className="pr-4 tabular-nums">{formatDateTime(account.createdAt)}</TableCell>
    </TableRow>
  ));
}
