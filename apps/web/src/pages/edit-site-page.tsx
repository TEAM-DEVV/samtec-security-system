import type { Site, UpdateSiteRequest } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { routes } from '@/app/routes';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { SiteForm, type SiteValues } from '@/components/site-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { usePageTitle } from '@/lib/page-title';

/**
 * Changes a site's record (ADMIN and HR_PAYROLL).
 *
 * Only what actually changed is sent, so the API never refuses an empty
 * change. The code is never sent: it is printed on devices and documents and
 * the form shows it read-only. Switching to INACTIVE while anybody is still
 * posted there, or a device there is switched on, comes back as a plain
 * conflict message from the API.
 */
export function EditSitePage() {
  const { siteId = '' } = useParams<{ siteId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const site = $api.useQuery('get', '/sites/{siteId}', { params: { path: { siteId } } });
  usePageTitle(site.data ? `Edit ${site.data.code}` : 'Edit site');

  const update = $api.useMutation('patch', '/sites/{siteId}');

  function submit(values: SiteValues) {
    const record = site.data;
    if (record === undefined || values.region === '') {
      return;
    }
    const body = onlyWhatChanged(record, values);
    if (Object.keys(body).length === 0) {
      // Nothing to save, so go back rather than send a change the API refuses.
      void navigate(routes.site(siteId));
      return;
    }
    update.mutate(
      { params: { path: { siteId } }, body },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ['get', '/sites'] });
          void navigate(routes.site(siteId));
        },
      },
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Link
        to={site.data ? routes.site(siteId) : routes.sites}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {site.data ? site.data.code : 'Sites'}
      </Link>

      <PageHeader eyebrow="Workforce" title="Edit site" />

      {site.isError ? (
        <LoadErrorAlert
          title="The site could not be loaded"
          error={site.error}
          retrying={site.isFetching}
          onRetry={() => void site.refetch()}
        />
      ) : site.isPending ? (
        <>
          <span role="status" className="sr-only">
            Loading site…
          </span>
          <Skeleton aria-hidden="true" className="h-96 w-full" />
        </>
      ) : (
        <Card className="rounded-2xl motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="font-heading text-lg">{site.data.name}</CardTitle>
            <CardDescription className="font-mono">{site.data.code}</CardDescription>
          </CardHeader>
          <CardContent>
            <SiteForm
              initial={site.data}
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

/** The fields that actually differ, in the shape the API wants. The code is never sent. */
function onlyWhatChanged(record: Site, values: SiteValues): UpdateSiteRequest {
  const body: UpdateSiteRequest = {};
  if (values.name !== record.name) {
    body.name = values.name;
  }
  if (values.clientName !== record.clientName) {
    body.clientName = values.clientName;
  }
  if (values.region !== '' && values.region !== record.region) {
    body.region = values.region;
  }
  if (values.city !== record.city) {
    body.city = values.city;
  }
  if (values.status !== record.status) {
    body.status = values.status;
  }
  return body;
}
