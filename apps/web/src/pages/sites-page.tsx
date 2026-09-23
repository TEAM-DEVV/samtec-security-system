import type { GhanaRegion, SiteList, SiteStatus } from '@samtec/contracts';
import { cn } from 'cn';
import { MapPin } from 'lucide-react';
import { useState } from 'react';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { SelectField } from '@/components/select-field';
import {
  isSiteStatus,
  SITE_STATUSES,
  SiteStatusBadge,
  siteStatusLabels,
} from '@/components/site-status-badge';
import { TableEmptyRow, TableLoadingRows } from '@/components/table-states';
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
import { useCursorPages } from '@/lib/cursor-pages';
import { GHANA_REGIONS, isGhanaRegion, regionLabels } from '@/lib/ghana-regions';
import { usePageTitle } from '@/lib/page-title';

const PAGE_SIZE = 10;
const COLUMN_COUNT = 6;

/**
 * Lists the client sites the signed-in user may see (the API limits a
 * supervisor to their own site), with status and region filters and cursor
 * pagination. Same shape as the Employees page.
 */
export function SitesPage() {
  usePageTitle('Sites');
  const [status, setStatus] = useState<SiteStatus>();
  const [region, setRegion] = useState<GhanaRegion>();
  const pages = useCursorPages();

  const sites = $api.useQuery(
    'get',
    '/sites',
    { params: { query: { limit: PAGE_SIZE, cursor: pages.cursor, status, region } } },
    // Keep showing the current page while the next one loads.
    { placeholderData: (previous) => previous },
  );

  const showingOldPage = sites.isPlaceholderData;
  // No Next under an error alert: the kept placeholder data may still hold a bookmark.
  const nextCursor = sites.error ? null : (sites.data?.nextCursor ?? null);

  function applyStatus(value: string) {
    setStatus(isSiteStatus(value) ? value : undefined);
    pages.reset();
  }

  function applyRegion(value: string) {
    setRegion(isGhanaRegion(value) ? value : undefined);
    pages.reset();
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        eyebrow="Workforce"
        title="Sites"
        description="Client locations where guards are posted."
      />

      <div className="flex flex-wrap items-start gap-4 rounded-2xl border bg-card/60 p-4">
        <SelectField id="site-status" label="Status" value={status ?? ''} onChange={applyStatus}>
          <option value="">All statuses</option>
          {SITE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {siteStatusLabels[value]}
            </option>
          ))}
        </SelectField>

        <SelectField id="site-region" label="Region" value={region ?? ''} onChange={applyRegion}>
          <option value="">All regions</option>
          {GHANA_REGIONS.map((value) => (
            <option key={value} value={value}>
              {regionLabels[value]}
            </option>
          ))}
        </SelectField>
      </div>

      {sites.error ? (
        <LoadErrorAlert
          title="Sites could not be loaded"
          error={sites.error}
          retrying={sites.isFetching}
          onRetry={() => void sites.refetch()}
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

      <PaginationNav pages={pages} nextCursor={nextCursor} busy={showingOldPage} />
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
    return <TableLoadingRows colSpan={COLUMN_COUNT} label="Loading sites…" rows={3} />;
  }

  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow
        colSpan={COLUMN_COUNT}
        icon={MapPin}
        // A supervisor with no posting sees no sites even with no filter set.
        title={filtered ? 'No sites match these filters.' : 'No sites to show yet.'}
        hint={filtered ? 'Clear a filter to see more.' : undefined}
      />
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
