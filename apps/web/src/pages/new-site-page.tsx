import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { routes } from '@/app/routes';
import { PageHeader } from '@/components/page-header';
import { SiteForm, type SiteValues } from '@/components/site-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { $api } from '@/lib/api';
import { usePageTitle } from '@/lib/page-title';

/**
 * Adds a client site (ADMIN and HR_PAYROLL).
 *
 * The code is short and unique in the company (like `ACC-01`); once the site
 * exists it is printed on devices and documents, so it can never be changed
 * here afterwards.
 */
export function NewSitePage() {
  usePageTitle('Add site');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = $api.useMutation('post', '/sites', {
    onSuccess: (site) => {
      // The list is out of date now; reload it next time it is shown.
      void queryClient.invalidateQueries({ queryKey: ['get', '/sites'] });
      void navigate(routes.site(site.id));
    },
  });

  function submit(values: SiteValues) {
    if (values.region === '') {
      return;
    }
    create.mutate({
      body: {
        code: values.code,
        name: values.name,
        clientName: values.clientName,
        region: values.region,
        city: values.city,
        status: values.status,
      },
    });
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Link
        to={routes.sites}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Sites
      </Link>

      <PageHeader eyebrow="Workforce" title="Add site" />

      <Card className="rounded-2xl motion-safe:animate-rise-soft">
        <CardHeader>
          <CardTitle className="font-heading text-lg">Site details</CardTitle>
          <CardDescription>
            The code is printed on devices and documents, so choose it carefully: it cannot be
            changed once the site exists.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SiteForm
            submitLabel="Add site"
            pending={create.isPending}
            error={create.error}
            onSubmit={submit}
          />
        </CardContent>
      </Card>
    </div>
  );
}
