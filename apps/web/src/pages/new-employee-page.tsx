import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { routes } from '@/app/routes';
import { EmployeeForm, type EmployeeValues } from '@/components/employee-form';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { $api } from '@/lib/api';
import { usePageTitle } from '@/lib/page-title';

/**
 * Registers a new employee (ADMIN and HR_PAYROLL).
 *
 * The API generates the staff number, so this form never asks for one. A new
 * person starts as "Awaiting enrolment" and is not paid until their face is
 * enrolled at a kiosk — that is the whole point of the system, so the page
 * says so before anyone wonders why the new guard is not on the payroll.
 */
export function NewEmployeePage() {
  usePageTitle('Add employee');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = $api.useMutation('post', '/employees', {
    onSuccess: (employee) => {
      // The list is out of date now; reload it next time it is shown.
      void queryClient.invalidateQueries({ queryKey: ['get', '/employees'] });
      void navigate(routes.employee(employee.id));
    },
  });

  function submit(values: EmployeeValues) {
    create.mutate({
      body: {
        firstName: values.firstName,
        lastName: values.lastName,
        // The contract wants these fields left out, not empty or null.
        ...(values.otherNames !== '' && { otherNames: values.otherNames }),
        phone: values.phone,
        ...(values.email !== '' && { email: values.email }),
        ghanaCardNumber: values.ghanaCardNumber,
        position: values.position,
        hireDate: values.hireDate,
        ...(values.posting.siteId !== '' && {
          siteId: values.posting.siteId,
          // A post and a shift only travel with a site.
          ...(values.posting.postId !== '' && { postId: values.posting.postId }),
          ...(values.posting.shiftPatternId !== '' && {
            shiftPatternId: values.posting.shiftPatternId,
          }),
        }),
      },
    });
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Link
        to={routes.employees}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Employees
      </Link>

      <PageHeader eyebrow="Workforce" title="Add employee" />

      <Card className="rounded-2xl motion-safe:animate-rise-soft">
        <CardHeader>
          <CardTitle className="font-heading text-lg">Their details</CardTitle>
          <CardDescription>
            The staff number is given out by the system. The new person starts as{' '}
            <strong className="font-medium">Awaiting enrolment</strong>: their hours are recorded
            but not paid until their face is enrolled at a kiosk.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmployeeForm
            submitLabel="Register employee"
            pending={create.isPending}
            error={create.error}
            onSubmit={submit}
          />
        </CardContent>
      </Card>
    </div>
  );
}
