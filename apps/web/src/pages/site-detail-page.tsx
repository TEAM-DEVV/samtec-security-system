import type { Device, DeviceList, EmployeeList, Post, PostList, Site } from '@samtec/contracts';
import { ArrowLeft, ClipboardList, Pencil, TabletSmartphone, Users } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { routes } from '@/app/routes';
import { DeviceStatusBadge } from '@/components/attendance-badges';
import { DetailRow } from '@/components/detail-row';
import { EmployeeStatusBadge } from '@/components/employee-status-badge';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { SiteStatusBadge } from '@/components/site-status-badge';
import { TableEmptyRow, TableLoadingRows } from '@/components/table-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { formatDateTime } from '@/lib/format';
import { regionLabels } from '@/lib/ghana-regions';
import { usePageTitle } from '@/lib/page-title';
import { isProblemDetails } from '@/lib/problem';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

/** The contract's largest page. A site has far fewer posts, devices or workers than this. */
const PAGE_SIZE = 100;
const POST_COLUMNS = 3;
const DEVICE_COLUMNS = 3;
const WORKER_COLUMNS = 5;

/**
 * One client site's own page: its details, its posts, the devices installed
 * there (ADMIN only), and the workers currently posted there. A supervisor
 * may open this only for their own site; the API answers 404 for any other,
 * the same way it does for an unknown ID, so this page shows the same "No
 * site found" message either way.
 */
export function SiteDetailPage() {
  const { siteId = '' } = useParams<{ siteId: string }>();
  const session = useSession();
  const site = $api.useQuery('get', '/sites/{siteId}', { params: { path: { siteId } } });
  // The code, never the name: browser history on a shared computer must not
  // reveal which client sites were looked at.
  usePageTitle(site.data ? site.data.code : 'Site');
  const mayOpenList = session !== null && roleAllowed(pageRoles.sites, session.user.role);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      {mayOpenList && (
        <Link
          to={routes.sites}
          className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Sites
        </Link>
      )}

      {site.isError ? (
        <LoadError
          error={site.error}
          retrying={site.isFetching}
          onRetry={() => void site.refetch()}
        />
      ) : site.isPending ? (
        <LoadingRecord />
      ) : (
        <SiteRecord site={site.data} siteId={siteId} />
      )}
    </div>
  );
}

function SiteRecord({ site, siteId }: { site: Site; siteId: string }) {
  const session = useSession();
  const mayChange = session !== null && roleAllowed(pageRoles.siteChanges, session.user.role);
  const maySeeDevices = session !== null && roleAllowed(pageRoles.devices, session.user.role);

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-card/60 p-5 motion-safe:animate-rise-soft">
        <div className="space-y-1">
          <h1 className="font-semibold text-3xl tracking-tight">{site.name}</h1>
          <p className="font-mono text-muted-foreground text-sm">{site.code}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SiteStatusBadge status={site.status} />
          {mayChange && (
            <Button asChild variant="outline" size="sm">
              <Link to={routes.editSite(site.id)}>
                <Pencil aria-hidden="true" />
                Edit
              </Link>
            </Button>
          )}
        </div>
      </header>

      <Card className="stagger-1 rounded-2xl motion-safe:animate-rise-soft">
        <CardHeader>
          <CardTitle className="font-heading text-lg">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <DetailRow term="Client">{site.clientName}</DetailRow>
            <DetailRow term="Location">
              {site.city}
              <span className="text-muted-foreground">
                , {regionLabels[site.region] ?? site.region}
              </span>
            </DetailRow>
            <DetailRow term="Guards on post">
              <span className="tabular-nums">{site.activeGuardCount}</span>
            </DetailRow>
          </dl>
        </CardContent>
      </Card>

      <PostsCard siteId={siteId} />
      {maySeeDevices && <DevicesCard siteId={siteId} />}
      <WorkersCard siteId={siteId} />

      <p className="text-muted-foreground text-xs">
        Site added {formatDateTime(site.createdAt)}, last changed {formatDateTime(site.updatedAt)}{' '}
        (Ghana time).
      </p>
    </>
  );
}

function PostsCard({ siteId }: { siteId: string }) {
  const posts = $api.useQuery('get', '/sites/{siteId}/posts', {
    params: { path: { siteId }, query: { limit: PAGE_SIZE } },
  });

  return (
    <Card className="stagger-2 rounded-2xl motion-safe:animate-rise-soft">
      <CardHeader>
        <CardTitle className="font-heading text-lg">Posts</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {posts.isError ? (
          <div className="px-6">
            <LoadErrorAlert
              title="Posts could not be loaded"
              error={posts.error}
              retrying={posts.isFetching}
              onRetry={() => void posts.refetch()}
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Guards needed</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <PostRows loading={posts.isPending} page={posts.data} />
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function PostRows({ loading, page }: { loading: boolean; page: PostList | undefined }) {
  if (loading) {
    return <TableLoadingRows colSpan={POST_COLUMNS} label="Loading posts…" rows={2} />;
  }
  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow
        colSpan={POST_COLUMNS}
        icon={ClipboardList}
        title="No posts at this site yet."
      />
    );
  }
  return page.items.map((post: Post) => (
    <TableRow key={post.id}>
      <TableCell className="pl-6 font-medium">{post.name}</TableCell>
      <TableCell className="tabular-nums">{post.requiredGuards}</TableCell>
      <TableCell className="pr-6">
        {post.status === 'ACTIVE' ? (
          'Active'
        ) : (
          <span className="text-muted-foreground">Closed</span>
        )}
      </TableCell>
    </TableRow>
  ));
}

function DevicesCard({ siteId }: { siteId: string }) {
  const devices = $api.useQuery('get', '/devices', {
    params: { query: { siteId, limit: PAGE_SIZE } },
  });

  return (
    <Card className="stagger-3 rounded-2xl motion-safe:animate-rise-soft">
      <CardHeader>
        <CardTitle className="font-heading text-lg">Devices</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {devices.isError ? (
          <div className="px-6">
            <LoadErrorAlert
              title="Devices could not be loaded"
              error={devices.error}
              retrying={devices.isFetching}
              onRetry={() => void devices.refetch()}
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <DeviceRows loading={devices.isPending} page={devices.data} />
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function DeviceRows({ loading, page }: { loading: boolean; page: DeviceList | undefined }) {
  if (loading) {
    return <TableLoadingRows colSpan={DEVICE_COLUMNS} label="Loading devices…" rows={2} />;
  }
  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow
        colSpan={DEVICE_COLUMNS}
        icon={TabletSmartphone}
        title="No devices at this site yet."
      />
    );
  }
  return page.items.map((device: Device) => (
    <TableRow key={device.id}>
      <TableCell className="pl-6 font-medium">
        <Link
          to={routes.device(device.id)}
          className="text-primary underline underline-offset-4 hover:no-underline"
        >
          {device.name}
        </Link>
      </TableCell>
      <TableCell>{deviceKindLabel(device.kind)}</TableCell>
      <TableCell className="pr-6">
        <DeviceStatusBadge status={device.status} />
      </TableCell>
    </TableRow>
  ));
}

function deviceKindLabel(kind: Device['kind']): string {
  switch (kind) {
    case 'ZKTECO':
      return 'Fingerprint terminal';
    case 'FACE_KIOSK':
      return 'Face kiosk';
    default:
      return 'Simulator';
  }
}

function WorkersCard({ siteId }: { siteId: string }) {
  const employees = $api.useQuery('get', '/employees', {
    params: { query: { siteId, limit: PAGE_SIZE } },
  });

  return (
    <Card className="stagger-4 rounded-2xl motion-safe:animate-rise-soft">
      <CardHeader>
        <CardTitle className="font-heading text-lg">Workers posted here</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {employees.isError ? (
          <div className="px-6">
            <LoadErrorAlert
              title="Workers could not be loaded"
              error={employees.error}
              retrying={employees.isFetching}
              onRetry={() => void employees.refetch()}
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Staff no.</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Position</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-6">Post and shift</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <WorkerRows loading={employees.isPending} page={employees.data} />
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function WorkerRows({ loading, page }: { loading: boolean; page: EmployeeList | undefined }) {
  if (loading) {
    return <TableLoadingRows colSpan={WORKER_COLUMNS} label="Loading workers…" rows={3} />;
  }
  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow colSpan={WORKER_COLUMNS} icon={Users} title="Nobody is posted here yet." />
    );
  }
  return page.items.map((employee) => (
    <TableRow key={employee.id}>
      <TableCell className="pl-6 font-mono text-xs">
        <Link
          to={routes.employee(employee.id)}
          className="text-primary underline underline-offset-4 hover:no-underline"
        >
          {employee.staffNumber}
        </Link>
      </TableCell>
      <TableCell className="font-medium">{employee.fullName}</TableCell>
      <TableCell>{employee.position}</TableCell>
      <TableCell>
        <EmployeeStatusBadge status={employee.status} />
      </TableCell>
      <TableCell className="pr-6">
        {employee.currentPost ? (
          employee.currentPost.name
        ) : (
          <span className="text-muted-foreground">No particular post</span>
        )}
        {employee.currentShiftPattern && (
          <span className="text-muted-foreground">
            {' '}
            · {employee.currentShiftPattern.name} ({employee.currentShiftPattern.startTime}–
            {employee.currentShiftPattern.endTime})
          </span>
        )}
      </TableCell>
    </TableRow>
  ));
}

function LoadingRecord() {
  return (
    <div className="grid gap-4">
      <span role="status" className="sr-only">
        Loading site…
      </span>
      <Skeleton aria-hidden="true" className="h-24 w-full" />
      <Skeleton aria-hidden="true" className="h-40 w-full" />
      <Skeleton aria-hidden="true" className="h-40 w-full" />
    </div>
  );
}

interface LoadErrorProps {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}

/**
 * A 404 gets its own wording: the API answers it both for an unknown ID and
 * for a site this supervisor is not posted to, on purpose, so the page says
 * only that nothing was found.
 */
function LoadError({ error, retrying, onRetry }: LoadErrorProps) {
  if (isProblemDetails(error) && error.status === 404) {
    return (
      <Alert>
        <AlertTitle>No site found</AlertTitle>
        <AlertDescription>
          <p>There is no site with this ID that you can see.</p>
          <p className="font-mono text-xs">Trace ID: {error.traceId}</p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <LoadErrorAlert
      title="The site could not be loaded"
      error={error}
      retrying={retrying}
      onRetry={onRetry}
    />
  );
}
