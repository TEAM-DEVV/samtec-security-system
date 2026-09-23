import { useState } from 'react';
import { DateRangeForm } from '@/components/date-range-form';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { SegmentsTable } from '@/components/segments-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { $api } from '@/lib/api';
import { useCursorPages } from '@/lib/cursor-pages';
import { addDays, formatMinutes, todayInGhana } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 25;
const DEFAULT_RANGE_DAYS = 14;

/**
 * The signed-in person's own shifts: what a guard sees, and what a
 * supervisor can check about themselves. The API limits the answer to the
 * employee linked to the account.
 */
export function MyAttendancePage() {
  usePageTitle('My attendance');
  const session = useSession();
  const employeeId = session?.user.employeeId ?? null;
  const [range, setRange] = useState(() => {
    const today = todayInGhana();
    return { from: addDays(today, -DEFAULT_RANGE_DAYS), to: today };
  });
  const pages = useCursorPages();

  const segments = $api.useQuery(
    'get',
    '/attendance/segments',
    {
      params: {
        query: {
          from: range.from,
          to: range.to,
          employeeId: employeeId ?? '',
          limit: PAGE_SIZE,
          cursor: pages.cursor,
        },
      },
    },
    { enabled: employeeId !== null, placeholderData: (previous) => previous },
  );
  const showingOldPage = segments.isPlaceholderData;
  const nextCursor = segments.error ? null : (segments.data?.nextCursor ?? null);
  const pageMinutes = (segments.data?.items ?? []).reduce(
    (total, segment) => (segment.status === 'VOIDED' ? total : total + segment.workedMinutes),
    0,
  );

  if (employeeId === null) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <PageHeader eyebrow="Attendance" title="My attendance" />
        <Alert>
          <AlertTitle>No employee record is linked to your account</AlertTitle>
          <AlertDescription>
            Administrator and HR accounts are not on the roster, so there are no clock-ins to show.
            Supervisors and guards see their own shifts here.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        eyebrow="Attendance"
        title="My attendance"
        description="Your clock-ins paired into shifts. Hours count on the day the shift started."
      />

      <div className="rounded-2xl border bg-card/60 p-4">
        <DateRangeForm
          idPrefix="my-attendance"
          initial={range}
          onApply={(next) => {
            setRange(next);
            pages.reset();
          }}
        />
      </div>

      {segments.error ? (
        <LoadErrorAlert
          title="Your shifts could not be loaded"
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
            showEmployee={false}
            filtered={false}
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
