import type { EmployeeList, EmployeeStatus } from '@samtec/contracts';
import { cn } from 'cn';
import { Search, UserPlus, Users } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import {
  EMPLOYEE_STATUSES,
  EmployeeStatusBadge,
  employeeStatusLabels,
  isEmployeeStatus,
} from '@/components/employee-status-badge';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { SelectField } from '@/components/select-field';
import { TableEmptyRow, TableLoadingRows } from '@/components/table-states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { $api } from '@/lib/api';
import { useCursorPages } from '@/lib/cursor-pages';
import { formatDate } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 10;
const COLUMN_COUNT = 7;
// The contract's limits for the `search` parameter.
const SEARCH_MIN_LENGTH = 2;
const SEARCH_MAX_LENGTH = 100;

/**
 * Lists employees with a search box, a status filter and cursor pagination.
 *
 * This is the reference page for every list: one query hook, the shared
 * toolkit for pagination, loading, empty and error states, and the page
 * itself only decides its columns and filters.
 */
export function EmployeesPage() {
  usePageTitle('Employees');
  const session = useSession();
  // A supervisor reads this list but may not change anybody on it.
  const mayAdd = session !== null && roleAllowed(pageRoles.employeeChanges, session.user.role);
  const [searchInput, setSearchInput] = useState('');
  const [searchTooShort, setSearchTooShort] = useState(false);
  const [search, setSearch] = useState<string>();
  const [status, setStatus] = useState<EmployeeStatus>();
  const pages = useCursorPages();

  const employees = $api.useQuery(
    'get',
    '/employees',
    { params: { query: { limit: PAGE_SIZE, cursor: pages.cursor, status, search } } },
    // Keep showing the current page while the next one loads.
    { placeholderData: (previous) => previous },
  );

  // True while the table still shows the previous page and the new one is loading.
  const showingOldPage = employees.isPlaceholderData;
  // No Next under an error alert: the kept placeholder data may still hold a bookmark.
  const nextCursor = employees.error ? null : (employees.data?.nextCursor ?? null);

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = searchInput.trim();
    // An empty box shows everyone. One character is too short for the API.
    if (text.length > 0 && text.length < SEARCH_MIN_LENGTH) {
      setSearchTooShort(true);
      return;
    }
    setSearchTooShort(false);
    setSearch(text.length > 0 ? text : undefined);
    pages.reset();
  }

  function applyStatus(value: string) {
    setStatus(isEmployeeStatus(value) ? value : undefined);
    pages.reset();
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        eyebrow="Workforce"
        title="Employees"
        description="Guards and staff on the company payroll."
        actions={
          mayAdd ? (
            <Button asChild>
              <Link to={routes.newEmployee}>
                <UserPlus aria-hidden="true" />
                Add employee
              </Link>
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-start gap-4 rounded-2xl border bg-card/60 p-4">
        <form onSubmit={applySearch} className="grid w-full gap-1.5 sm:w-auto">
          <Label htmlFor="employee-search">Search employees</Label>
          <div className="flex gap-2">
            <Input
              id="employee-search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Name or staff number"
              maxLength={SEARCH_MAX_LENGTH}
              aria-describedby="employee-search-hint"
              aria-invalid={searchTooShort}
              className="min-w-0 flex-1 sm:w-64 sm:flex-none"
            />
            <Button type="submit" variant="secondary">
              <Search aria-hidden="true" />
              Search
            </Button>
          </div>
          <p
            id="employee-search-hint"
            className={cn('text-xs', searchTooShort ? 'text-destructive' : 'text-muted-foreground')}
          >
            Type at least {SEARCH_MIN_LENGTH} characters.
          </p>
        </form>

        <SelectField
          id="employee-status"
          label="Status"
          value={status ?? ''}
          onChange={applyStatus}
        >
          <option value="">All statuses</option>
          {EMPLOYEE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {employeeStatusLabels[value]}
            </option>
          ))}
        </SelectField>
      </div>

      {employees.error ? (
        <LoadErrorAlert
          title="Employees could not be loaded"
          error={employees.error}
          retrying={employees.isFetching}
          onRetry={() => void employees.refetch()}
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
              <TableRow className="bg-muted/50 hover:bg-muted/50 [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-[0.14em] [&_th]:text-muted-foreground">
                <TableHead className="pl-4">Staff no.</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Position</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Biometrics</TableHead>
                <TableHead className="pr-4">Hired</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <EmployeeRows
                loading={employees.isPending}
                page={employees.data}
                filtered={status !== undefined || search !== undefined}
              />
            </TableBody>
          </Table>
        </Card>
      )}

      <PaginationNav pages={pages} nextCursor={nextCursor} busy={showingOldPage} />
    </div>
  );
}

interface EmployeeRowsProps {
  loading: boolean;
  page: EmployeeList | undefined;
  /** True when a search or filter is set, so the empty message can say so. */
  filtered: boolean;
}

function EmployeeRows({ loading, page, filtered }: EmployeeRowsProps) {
  if (loading) {
    return <TableLoadingRows colSpan={COLUMN_COUNT} label="Loading employees…" />;
  }

  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow
        colSpan={COLUMN_COUNT}
        icon={Users}
        title={filtered ? 'No employees match these filters.' : 'No employees to show yet.'}
        hint={filtered ? 'Clear the search or the filter to see more.' : undefined}
      />
    );
  }

  return page.items.map((employee) => (
    <TableRow key={employee.id}>
      <TableCell className="pl-4 font-mono text-xs">{employee.staffNumber}</TableCell>
      <TableCell className="font-medium">
        <Link
          to={routes.employee(employee.id)}
          className="text-primary underline underline-offset-4 hover:no-underline"
        >
          {employee.fullName}
        </Link>
      </TableCell>
      <TableCell>{employee.position}</TableCell>
      <TableCell>
        {employee.currentSite ? (
          employee.currentSite.name
        ) : (
          <span className="text-muted-foreground">Not posted</span>
        )}
      </TableCell>
      <TableCell>
        <EmployeeStatusBadge status={employee.status} />
      </TableCell>
      <TableCell>
        {employee.biometricEnrolledAt ? (
          'Enrolled'
        ) : (
          <span className="text-muted-foreground">Not enrolled</span>
        )}
      </TableCell>
      <TableCell className="pr-4 tabular-nums">{formatDate(employee.hireDate)}</TableCell>
    </TableRow>
  ));
}
