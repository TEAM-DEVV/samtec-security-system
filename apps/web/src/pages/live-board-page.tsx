import type { PunchFeedItem, PunchFeedList } from '@samtec/contracts';
import { cn } from 'cn';
import { Radio } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { PunchMethodBadge } from '@/components/biometrics-badges';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { SiteSelect, useSiteNames } from '@/components/site-select';
import { TableEmptyRow, TableLoadingRows } from '@/components/table-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { punchDirectionLabels } from '@/lib/attendance';
import { LIVE_BOARD_REFRESH_MS } from '@/lib/biometrics';
import { useCursorPages } from '@/lib/cursor-pages';
import { formatClock, formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';

const PAGE_SIZE = 50;
const COLUMN_COUNT = 6;

/**
 * Every clock-in and clock-out as it arrives, newest first, refreshed every
 * five seconds while this page is open (a kiosk punch reaches it within that
 * time). The flagged methods, which do not prove who was there, stand out.
 */
export function LiveBoardPage() {
  usePageTitle('Live board');
  const [siteId, setSiteId] = useState('');
  const pages = useCursorPages();
  const siteNames = useSiteNames();
  const onFirstPage = pages.cursor === undefined;

  const punches = $api.useQuery(
    'get',
    '/attendance/punches',
    {
      params: {
        query: { ...(siteId !== '' && { siteId }), limit: PAGE_SIZE, cursor: pages.cursor },
      },
    },
    {
      placeholderData: (previous) => previous,
      // Only the newest page is live; older pages do not change.
      refetchInterval: onFirstPage ? LIVE_BOARD_REFRESH_MS : false,
    },
  );
  const showingOldPage = punches.isPlaceholderData;
  const nextCursor = punches.error ? null : (punches.data?.nextCursor ?? null);
  // A dropped poll must not blank the board: the last good rows stay up
  // while the next poll is tried, and only a board with nothing yet shows the error.
  const lostFirstLoad = punches.error && !punches.data;
  const refreshFailed = punches.error && punches.data;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        eyebrow="Attendance"
        title="Live board"
        description="Each punch as the devices send it, newest first. Amber means the method did not prove who was there."
        actions={<LiveIndicator live={onFirstPage} updatedAt={punches.dataUpdatedAt} />}
      />

      <div className="flex flex-wrap items-start gap-4 rounded-2xl border bg-card/60 p-4">
        <SiteSelect
          id="live-site"
          label="Site"
          value={siteId}
          emptyLabel="All sites"
          onChange={(value) => {
            setSiteId(value);
            pages.reset();
          }}
        />
      </div>

      {refreshFailed && (
        <Alert>
          <AlertTitle>The board could not refresh</AlertTitle>
          <AlertDescription>
            These are the punches from {formatClock(punches.dataUpdatedAt)}. Still trying every few
            seconds.
          </AlertDescription>
        </Alert>
      )}

      {lostFirstLoad ? (
        <LoadErrorAlert
          title="The board could not be loaded"
          error={punches.error}
          retrying={punches.isFetching}
          onRetry={() => void punches.refetch()}
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
                <TableHead className="pl-4">Received</TableHead>
                <TableHead>Punch</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Device</TableHead>
                <TableHead className="pr-4">Method</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <PunchRows
                loading={punches.isPending}
                page={punches.data}
                siteNames={siteNames}
                filtered={siteId !== ''}
              />
            </TableBody>
          </Table>
        </Card>
      )}

      <PaginationNav pages={pages} nextCursor={nextCursor} busy={showingOldPage} />
    </div>
  );
}

/**
 * "Live · 08:30:07": the board's pulse, so a person can see it is still
 * refreshing. Only the word is announced to screen readers; the clock would
 * otherwise be read out every five seconds.
 */
function LiveIndicator({ live, updatedAt }: { live: boolean; updatedAt: number }) {
  return (
    <p className="flex items-center gap-2 text-muted-foreground text-sm tabular-nums">
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          live ? 'bg-emerald-500 motion-safe:animate-pulse' : 'bg-slate-400',
        )}
      />
      <span role="status">{live ? 'Live' : 'Paused'}</span>
      {updatedAt > 0 && <span aria-hidden="true"> · {formatClock(updatedAt)}</span>}
    </p>
  );
}

interface PunchRowsProps {
  loading: boolean;
  page: PunchFeedList | undefined;
  siteNames: Map<string, string>;
  filtered: boolean;
}

function PunchRows({ loading, page, siteNames, filtered }: PunchRowsProps) {
  if (loading) {
    return <TableLoadingRows colSpan={COLUMN_COUNT} label="Loading the board…" />;
  }
  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow
        colSpan={COLUMN_COUNT}
        icon={Radio}
        title={filtered ? 'No punches at this site yet.' : 'No punches yet.'}
        hint="The next clock-in appears here within five seconds."
      />
    );
  }
  return page.items.map((punch) => (
    <PunchRow key={punch.id} punch={punch} siteName={siteNames.get(punch.siteId) ?? 'Site'} />
  ));
}

function PunchRow({ punch, siteName }: { punch: PunchFeedItem; siteName: string }) {
  return (
    <TableRow>
      <TableCell className="pl-4 tabular-nums">
        {formatDateTime(punch.serverTime)}
        {punch.clockSuspect && (
          <span className="ml-2 text-amber-800 text-xs dark:text-amber-300">clock suspect</span>
        )}
      </TableCell>
      <TableCell>{punchDirectionLabels[punch.direction]}</TableCell>
      <TableCell>
        {punch.employee ? (
          <>
            <Link
              to={routes.employee(punch.employee.id)}
              className="text-primary underline underline-offset-4 hover:no-underline"
            >
              {punch.employee.fullName}
            </Link>{' '}
            <span className="font-mono text-muted-foreground text-xs">
              {punch.employee.staffNumber}
            </span>
          </>
        ) : (
          <span className="text-amber-800 dark:text-amber-300">
            Unknown device user <span className="font-mono">{punch.deviceUserRef}</span>
          </span>
        )}
      </TableCell>
      <TableCell className="whitespace-normal">{siteName}</TableCell>
      <TableCell>{punch.deviceName}</TableCell>
      <TableCell className="pr-4">
        <PunchMethodBadge method={punch.method} />
      </TableCell>
    </TableRow>
  );
}
