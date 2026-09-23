import type { Device, DeviceList } from '@samtec/contracts';
import { cn } from 'cn';
import { Plus, TabletSmartphone } from 'lucide-react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { DeviceStatusBadge } from '@/components/attendance-badges';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { useSiteNames } from '@/components/site-select';
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
import { $api } from '@/lib/api';
import { describeDrift, deviceKindLabels, driftIsSuspect } from '@/lib/attendance';
import { useCursorPages } from '@/lib/cursor-pages';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';

const PAGE_SIZE = 25;
const COLUMN_COUNT = 7;

/**
 * Every terminal and kiosk of the company (ADMIN only) with its health: when
 * it last reported, how far its clock is off, and whether anyone has tried
 * to sign requests as it with the wrong secret.
 */
export function DevicesPage() {
  usePageTitle('Devices');
  const pages = useCursorPages();
  const siteNames = useSiteNames();

  const devices = $api.useQuery(
    'get',
    '/devices',
    { params: { query: { limit: PAGE_SIZE, cursor: pages.cursor } } },
    { placeholderData: (previous) => previous },
  );
  const showingOldPage = devices.isPlaceholderData;
  const nextCursor = devices.error ? null : (devices.data?.nextCursor ?? null);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        eyebrow="Attendance"
        title="Devices"
        description="The terminals and kiosks that record clock-ins. Each belongs to one site for life."
        actions={
          <Button asChild>
            <Link to={routes.newDevice}>
              <Plus aria-hidden="true" />
              Register device
            </Link>
          </Button>
        }
      />

      {devices.error ? (
        <LoadErrorAlert
          title="Devices could not be loaded"
          error={devices.error}
          retrying={devices.isFetching}
          onRetry={() => void devices.refetch()}
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
                <TableHead>Site</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Clock</TableHead>
                <TableHead className="pr-4 text-right">Bad signatures</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <DeviceRows loading={devices.isPending} page={devices.data} siteNames={siteNames} />
            </TableBody>
          </Table>
        </Card>
      )}

      <PaginationNav pages={pages} nextCursor={nextCursor} busy={showingOldPage} />
    </div>
  );
}

interface DeviceRowsProps {
  loading: boolean;
  page: DeviceList | undefined;
  siteNames: Map<string, string>;
}

function DeviceRows({ loading, page, siteNames }: DeviceRowsProps) {
  if (loading) {
    return <TableLoadingRows colSpan={COLUMN_COUNT} label="Loading devices…" />;
  }
  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow
        colSpan={COLUMN_COUNT}
        icon={TabletSmartphone}
        title="No devices registered yet."
        hint="Register one, and put its secret into the terminal or its gateway."
      />
    );
  }
  return page.items.map((device) => (
    <DeviceRow key={device.id} device={device} siteNames={siteNames} />
  ));
}

function DeviceRow({ device, siteNames }: { device: Device; siteNames: Map<string, string> }) {
  const suspect = driftIsSuspect(device.lastClockDriftSeconds);
  const attacked = device.failedSignatureCount > 0;
  return (
    <TableRow>
      <TableCell className="pl-4 font-medium">
        <Link
          to={routes.device(device.id)}
          className="text-primary underline underline-offset-4 hover:no-underline"
        >
          {device.name}
        </Link>
      </TableCell>
      <TableCell className="whitespace-normal">{siteNames.get(device.siteId) ?? 'Site'}</TableCell>
      <TableCell>{deviceKindLabels[device.kind]}</TableCell>
      <TableCell>
        <DeviceStatusBadge status={device.status} />
      </TableCell>
      <TableCell className="tabular-nums">
        {device.lastSeenAt ? (
          formatDateTime(device.lastSeenAt)
        ) : (
          <span className="text-muted-foreground">Never</span>
        )}
      </TableCell>
      <TableCell
        className={cn('tabular-nums', suspect && 'font-medium text-amber-800 dark:text-amber-300')}
      >
        {describeDrift(device.lastClockDriftSeconds)}
        {suspect && ' · suspect'}
      </TableCell>
      <TableCell
        className={cn(
          'pr-4 text-right tabular-nums',
          attacked && 'font-medium text-red-700 dark:text-red-300',
        )}
      >
        {device.failedSignatureCount}
      </TableCell>
    </TableRow>
  );
}
