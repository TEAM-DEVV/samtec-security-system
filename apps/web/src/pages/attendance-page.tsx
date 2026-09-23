import type { SegmentStatus } from '@samtec/contracts';
import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { DateRangeForm } from '@/components/date-range-form';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { SegmentsTable } from '@/components/segments-table';
import { SelectField } from '@/components/select-field';
import { SiteSelect } from '@/components/site-select';
import { Button } from '@/components/ui/button';
import { $api } from '@/lib/api';
import { isSegmentStatus, SEGMENT_STATUSES, segmentStatusLabels } from '@/lib/attendance';
import { useCursorPages } from '@/lib/cursor-pages';
import { addDays, formatMinutes, todayInGhana } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 25;
const DEFAULT_RANGE_DAYS = 7;

/**
 * Worked shifts for the company, one site, or one status, over a range of
 * days (a week by default). A supervisor's API answers only their sites; a
 * guard uses "My attendance" instead.
 */
export function AttendancePage() {
  usePageTitle('Attendance');
  const session = useSession();
  const [range, setRange] = useState(() => {
    const today = todayInGhana();
    return { from: addDays(today, -DEFAULT_RANGE_DAYS), to: today };
  });
  const [siteId, setSiteId] = useState('');
  const [status, setStatus] = useState<SegmentStatus>();
  const pages = useCursorPages();

  const segments = $api.useQuery(
    'get',
    '/attendance/segments',
    {
      params: {
        query: {
          from: range.from,
          to: range.to,
          ...(siteId !== '' && { siteId }),
          status,
          limit: PAGE_SIZE,
          cursor: pages.cursor,
        },
      },
    },
    { placeholderData: (previous) => previous },
  );
  const showingOldPage = segments.isPlaceholderData;
  const nextCursor = segments.error ? null : (segments.data?.nextCursor ?? null);
  const pageMinutes = (segments.data?.items ?? []).reduce(
    (total, segment) => (segment.status === 'VOIDED' ? total : total + segment.workedMinutes),
    0,
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        eyebrow="Attendance"
        title="Worked shifts"
        description="Each row is one clock-in paired with its clock-out. A night shift counts on the day it started."
        actions={
          <>
            {session?.user.employeeId && (
              <Button asChild variant="outline">
                <Link to={routes.myAttendance}>My attendance</Link>
              </Button>
            )}
            <Button asChild variant="outline">
              <Link to={routes.exceptions}>
                <ListChecks aria-hidden="true" />
                Exception queue
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 rounded-2xl border bg-card/60 p-4">
        <DateRangeForm
          idPrefix="attendance"
          initial={range}
          onApply={(next) => {
            setRange(next);
            pages.reset();
          }}
        />
        <div className="flex flex-wrap items-start gap-4">
          <SiteSelect
            id="attendance-site"
            label="Site"
            value={siteId}
            emptyLabel="All sites"
            onChange={(value) => {
              setSiteId(value);
              pages.reset();
            }}
          />
          <SelectField
            id="attendance-status"
            label="Status"
            value={status ?? ''}
            onChange={(value) => {
              setStatus(isSegmentStatus(value) ? value : undefined);
              pages.reset();
            }}
          >
            <option value="">Counted and disputed</option>
            {SEGMENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {segmentStatusLabels[value]}
              </option>
            ))}
          </SelectField>
        </div>
      </div>

      {segments.error ? (
        <LoadErrorAlert
          title="Shifts could not be loaded"
          error={segments.error}
          retrying={segments.isFetching}
          onRetry={() => void segments.refetch()}
        />
      ) : (
        <>
          <SegmentsTable
            loading={segments.isPending}
            page={segments.data}
            busy={showingOldPage}
            filtered={siteId !== '' || status !== undefined}
          />
          {segments.data && segments.data.items.length > 0 && (
            <p className="text-muted-foreground text-sm">
              {segments.data.items.length} shifts on this page, {formatMinutes(pageMinutes)}{' '}
              counted.
            </p>
          )}
        </>
      )}

      <PaginationNav pages={pages} nextCursor={nextCursor} busy={showingOldPage} />
    </div>
  );
}
