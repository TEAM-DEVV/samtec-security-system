import type { EmployeeList, EmployeeStatus } from '@samtec/contracts';
import { cn } from 'cn';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import {
  EMPLOYEE_STATUSES,
  EmployeeStatusBadge,
  employeeStatusLabels,
  isEmployeeStatus,
} from '@/components/employee-status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { $api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { describeApiError } from '@/lib/problem';

const PAGE_SIZE = 10;
const COLUMN_COUNT = 7;
// The contract's limits for the `search` parameter.
const SEARCH_MIN_LENGTH = 2;
const SEARCH_MAX_LENGTH = 100;
const LOADING_ROW_KEYS = ['loading-1', 'loading-2', 'loading-3', 'loading-4', 'loading-5'];

/**
 * Lists employees with a search box, a status filter and cursor pagination.
 *
 * This is the reference page for Phase 1. New list pages should follow the same
 * structure: one query hook, then the loading, error, empty and data states.
 */
export function EmployeesPage() {
  const [searchInput, setSearchInput] = useState('');
  const [searchTooShort, setSearchTooShort] = useState(false);
  const [search, setSearch] = useState<string>();
  const [status, setStatus] = useState<EmployeeStatus>();
  // The cursor of every page visited so far. The last one is the current page.
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);

  const employees = $api.useQuery(
    'get',
    '/employees',
    { params: { query: { limit: PAGE_SIZE, cursor: cursors.at(-1), status, search } } },
    // Keep showing the current page while the next one loads.
    { placeholderData: (previous) => previous },
  );

  // True while the table still shows the previous page and the new one is loading.
  const showingOldPage = employees.isPlaceholderData;
  const nextCursor = employees.data?.nextCursor ?? null;

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
    setCursors([undefined]);
  }

  function applyStatus(value: string) {
    setStatus(isEmployeeStatus(value) ? value : undefined);
    setCursors([undefined]);
  }

  function goToPreviousPage() {
    setCursors((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }

  function goToNextPage() {
    // Ignore clicks while a page is loading, so one click never skips a page.
    // The button stays enabled, so keyboard users never lose their place.
    if (nextCursor !== null && !showingOldPage) {
      setCursors((current) => [...current, nextCursor]);
    }
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="space-y-1">
        <h1 className="font-semibold text-2xl tracking-tight">Employees</h1>
        <p className="text-muted-foreground text-sm">Guards and staff on the company payroll.</p>
      </header>

      <div className="flex flex-wrap items-start gap-4">
        <form onSubmit={applySearch} className="grid gap-1.5">
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
              className="w-64"
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

        <div className="grid gap-1.5">
          <Label htmlFor="employee-status">Status</Label>
          <select
            id="employee-status"
            value={status ?? ''}
            onChange={(event) => applyStatus(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs"
          >
            <option value="">All statuses</option>
            {EMPLOYEE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {employeeStatusLabels[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {employees.error ? (
        <LoadError error={employees.error} onRetry={() => void employees.refetch()} />
      ) : (
        <Card
          aria-busy={showingOldPage}
          className={cn('overflow-hidden py-0 transition-opacity', showingOldPage && 'opacity-60')}
        >
          <Table>
            <TableHeader>
              <TableRow>
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
              <EmployeeRows loading={employees.isPending} page={employees.data} />
            </TableBody>
          </Table>
        </Card>
      )}

      <nav aria-label="Pagination" className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={cursors.length === 1}
          onClick={goToPreviousPage}
        >
          <ChevronLeft aria-hidden="true" />
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={nextCursor === null} onClick={goToNextPage}>
          Next
          <ChevronRight aria-hidden="true" />
        </Button>
      </nav>
    </div>
  );
}

function EmployeeRows({ loading, page }: { loading: boolean; page: EmployeeList | undefined }) {
  if (loading) {
    return LOADING_ROW_KEYS.map((key, index) => (
      <TableRow key={key}>
        <TableCell colSpan={COLUMN_COUNT} className="px-4">
          {index === 0 && <span className="sr-only">Loading employees…</span>}
          <Skeleton aria-hidden="true" className="h-5 w-full" />
        </TableCell>
      </TableRow>
    ));
  }

  if (!page || page.items.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={COLUMN_COUNT} className="py-10 text-center text-muted-foreground">
          No employees match these filters.
        </TableCell>
      </TableRow>
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

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { message, traceId } = describeApiError(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>Employees could not be loaded</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{message}</p>
        {traceId && <p className="font-mono text-xs">Trace ID: {traceId}</p>}
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
