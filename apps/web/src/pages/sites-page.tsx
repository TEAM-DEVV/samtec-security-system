import type { GhanaRegion, SiteList, SiteStatus } from '@samtec/contracts';
import { cn } from 'cn';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import {
  isSiteStatus,
  SITE_STATUSES,
  SiteStatusBadge,
  siteStatusLabels,
} from '@/components/site-status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { GHANA_REGIONS, isGhanaRegion, regionLabels } from '@/lib/ghana-regions';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError } from '@/lib/problem';

const PAGE_SIZE = 10;
const COLUMN_COUNT = 6;
const LOADING_ROW_KEYS = ['loading-1', 'loading-2', 'loading-3'];

/**
 * Lists the client sites the signed-in user may see (the API limits a
 * supervisor to their own site), with status and region filters and cursor
 * pagination. Same shape as the Employees page.
 */
export function SitesPage() {
  usePageTitle('Sites');
  const [status, setStatus] = useState<SiteStatus>();
  const [region, setRegion] = useState<GhanaRegion>();
  // The cursor of every page visited so far. The last one is the current page.
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);

  const sites = $api.useQuery(
    'get',
    '/sites',
    { params: { query: { limit: PAGE_SIZE, cursor: cursors.at(-1), status, region } } },
    // Keep showing the current page while the next one loads.
    { placeholderData: (previous) => previous },
  );

  const showingOldPage = sites.isPlaceholderData;
  const nextCursor = sites.data?.nextCursor ?? null;

  function applyStatus(value: string) {
    setStatus(isSiteStatus(value) ? value : undefined);
    setCursors([undefined]);
  }

  function applyRegion(value: string) {
    setRegion(isGhanaRegion(value) ? value : undefined);
    setCursors([undefined]);
  }

  function goToPreviousPage() {
    setCursors((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }

  function goToNextPage() {
    // Ignore clicks while a page is loading, so one click never skips a page.
    if (nextCursor !== null && !showingOldPage) {
      setCursors((current) => [...current, nextCursor]);
    }
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader title="Sites" description="Client locations where guards are posted." />

      <div className="flex flex-wrap items-start gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="site-status">Status</Label>
          <select
            id="site-status"
            value={status ?? ''}
            onChange={(event) => applyStatus(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs"
          >
            <option value="">All statuses</option>
            {SITE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {siteStatusLabels[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="site-region">Region</Label>
          <select
            id="site-region"
            value={region ?? ''}
            onChange={(event) => applyRegion(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs"
          >
            <option value="">All regions</option>
            {GHANA_REGIONS.map((value) => (
              <option key={value} value={value}>
                {regionLabels[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {sites.error ? (
        <LoadError error={sites.error} onRetry={() => void sites.refetch()} />
      ) : (
        <Card
          aria-busy={showingOldPage}
          className={cn('overflow-hidden py-0 transition-opacity', showingOldPage && 'opacity-60')}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">Guards on post</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <SiteRows
                loading={sites.isPending}
                page={sites.data}
                filtered={status !== undefined || region !== undefined}
              />
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

interface SiteRowsProps {
  loading: boolean;
  page: SiteList | undefined;
  /** True when a filter is set, so the empty message can say so. */
  filtered: boolean;
}

function SiteRows({ loading, page, filtered }: SiteRowsProps) {
  if (loading) {
    return LOADING_ROW_KEYS.map((key, index) => (
      <TableRow key={key}>
        <TableCell colSpan={COLUMN_COUNT} className="px-4">
          {index === 0 && <span className="sr-only">Loading sites…</span>}
          <Skeleton aria-hidden="true" className="h-5 w-full" />
        </TableCell>
      </TableRow>
    ));
  }

  if (!page || page.items.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={COLUMN_COUNT} className="py-10 text-center text-muted-foreground">
          {/* A supervisor with no posting sees no sites even with no filter set. */}
          {filtered ? 'No sites match these filters.' : 'No sites to show yet.'}
        </TableCell>
      </TableRow>
    );
  }

  return page.items.map((site) => (
    <TableRow key={site.id}>
      <TableCell className="pl-4 font-mono text-xs">{site.code}</TableCell>
      <TableCell className="font-medium">{site.name}</TableCell>
      <TableCell>{site.clientName}</TableCell>
      <TableCell>
        {site.city}
        {/* The raw code is the fallback if the API adds a region before the dashboard learns its label. */}
        <span className="text-muted-foreground">, {regionLabels[site.region] ?? site.region}</span>
      </TableCell>
      <TableCell>
        <SiteStatusBadge status={site.status} />
      </TableCell>
      <TableCell className="pr-4 text-right tabular-nums">{site.activeGuardCount}</TableCell>
    </TableRow>
  ));
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { message, traceId } = describeApiError(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>Sites could not be loaded</AlertTitle>
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
