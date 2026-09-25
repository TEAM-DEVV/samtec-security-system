import type { Employee, UpdateEmployeeRequest } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { routes } from '@/app/routes';
import { EmployeeForm, type EmployeeValues } from '@/components/employee-form';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { usePageTitle } from '@/lib/page-title';

/**
 * Changes an employee's record (ADMIN and HR_PAYROLL).
 *
 * Only what actually changed is sent, so two people editing different fields
 * of the same person never overwrite each other. Nothing is sent at all when
 * nothing changed — the API refuses an empty change, and answering "saved" to
 * a request that was never made would be a lie.
 */
export function EditEmployeePage() {
  const { employeeId = '' } = useParams<{ employeeId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const employee = $api.useQuery('get', '/employees/{employeeId}', {
    params: { path: { employeeId } },
  });
  // The staff number, never the name: browser history on a shared computer
  // must not reveal which people were looked at.
  usePageTitle(employee.data ? `Edit ${employee.data.staffNumber}` : 'Edit employee');

  const update = $api.useMutation('patch', '/employees/{employeeId}', {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['get', '/employees'] });
      void navigate(routes.employee(employeeId));
    },
  });

  function submit(values: EmployeeValues) {
    const record = employee.data;
    if (record === undefined) {
      return;
    }
    const body = onlyWhatChanged(record, values);
    if (Object.keys(body).length === 0) {
      // Nothing to save, so go back rather than send a change the API refuses.
      void navigate(routes.employee(employeeId));
      return;
    }
    update.mutate({ params: { path: { employeeId } }, body });
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Link
        to={employee.data ? routes.employee(employeeId) : routes.employees}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {employee.data ? employee.data.staffNumber : 'Employees'}
      </Link>

      <PageHeader eyebrow="Workforce" title="Edit employee" />

      {employee.isError ? (
        <LoadErrorAlert
          title="The employee could not be loaded"
          error={employee.error}
          retrying={employee.isFetching}
          onRetry={() => void employee.refetch()}
        />
      ) : employee.isPending ? (
        <>
          <span role="status" className="sr-only">
            Loading employee…
          </span>
          <Skeleton aria-hidden="true" className="h-96 w-full" />
        </>
      ) : employee.data.status === 'TERMINATED' ? (
        <Alert>
          <AlertTitle>This record cannot be changed</AlertTitle>
          <AlertDescription>
            <p>
              {employee.data.fullName} has left the company. The record is kept as history and is
              never changed or deleted.
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <Card className="rounded-2xl motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="font-heading text-lg">{employee.data.fullName}</CardTitle>
            <CardDescription className="font-mono">{employee.data.staffNumber}</CardDescription>
          </CardHeader>
          <CardContent>
            <EmployeeForm
              initial={employee.data}
              submitLabel="Save changes"
              pending={update.isPending}
              error={update.error}
              onSubmit={submit}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * The fields that actually differ, in the shape the API wants.
 *
 * An empty optional box means "clear this", which the contract writes as
 * `null` rather than an empty string.
 *
 * The three posting fields move together. A post belongs to a site and a shift
 * is worked at a site, so the API only accepts a post or a shift alongside a
 * `siteId` — changing any one of them starts a fresh posting.
 */
function onlyWhatChanged(record: Employee, values: EmployeeValues): UpdateEmployeeRequest {
  const body: UpdateEmployeeRequest = {};
  if (values.firstName !== record.firstName) {
    body.firstName = values.firstName;
  }
  if (values.lastName !== record.lastName) {
    body.lastName = values.lastName;
  }
  const otherNames = values.otherNames === '' ? null : values.otherNames;
  if (otherNames !== (record.otherNames ?? null)) {
    body.otherNames = otherNames;
  }
  if (values.phone !== record.phone) {
    body.phone = values.phone;
  }
  const email = values.email === '' ? null : values.email;
  if (email !== (record.email ?? null)) {
    body.email = email;
  }
  if (values.position !== record.position) {
    body.position = values.position;
  }

  const was = {
    siteId: record.currentSite?.id ?? '',
    postId: record.currentPost?.id ?? '',
    shiftPatternId: record.currentShiftPattern?.id ?? '',
  };
  const now = values.posting;
  if (
    now.siteId !== was.siteId ||
    now.postId !== was.postId ||
    now.shiftPatternId !== was.shiftPatternId
  ) {
    body.siteId = now.siteId === '' ? null : now.siteId;
    body.postId = now.postId === '' ? null : now.postId;
    body.shiftPatternId = now.shiftPatternId === '' ? null : now.shiftPatternId;
  }
  return body;
}
