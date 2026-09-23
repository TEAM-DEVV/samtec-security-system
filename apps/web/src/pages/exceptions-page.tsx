import type {
  AttendanceExceptionList,
  AttendanceExceptionStatus,
  AttendanceExceptionType,
} from '@samtec/contracts';
import { cn } from 'cn';
import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { ExceptionTypeBadge } from '@/components/attendance-badges';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { SelectField } from '@/components/select-field';
import { SiteSelect, useSiteNames } from '@/components/site-select';
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
import {
  EXCEPTION_STATUSES,
  EXCEPTION_TYPES,
  exceptionStatusLabels,
  exceptionTypeLabels,
  isExceptionStatus,
  isExceptionType,
} from '@/lib/attendance';
import { useCursorPages } from '@/lib/cursor-pages';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';

const PAGE_SIZE = 20;
const COLUMN_COUNT = 5;

/**
 * The attendance exception queue: clock-ins a person must look at. Open
 * ones first by default; each row opens the exception with its evidence.
 */
export function ExceptionsPage() {
  usePageTitle('Exceptions');
  const [status, setStatus] = useState<AttendanceExceptionStatus>('OPEN');
  const [type, setType] = useState<AttendanceExceptionType>();
  const [siteId, setSiteId] = useState('');
  const pages = useCursorPages();
  const siteNames = useSiteNames();

  const exceptions = $api.useQuery(
    'get',
    '/attendance/exceptions',
    {
      params: {
        query: {
          status,
          type,
          ...(siteId !== '' && { siteId }),
          limit: PAGE_SIZE,
          cursor: pages.cursor,
        },
      },
    },
    { placeholderData: (previous) => previous },
  );
  const showingOldPage = exceptions.isPlaceholderData;
  const nextCursor = exceptions.error ? null : (exceptions.data?.nextCursor ?? null);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        eyebrow="Attendance"
        title="Exception queue"
        description="Clock-ins that need a person: a missing punch, a number nobody matches, someone who may not clock in, or two shifts at once."
      />

      <div className="flex flex-wrap items-start gap-4 rounded-2xl border bg-card/60 p-4">
        <SelectField
          id="exceptions-status"
          label="Status"
          value={status}
          onChange={(value) => {
            if (isExceptionStatus(value)) {
              setStatus(value);
              pages.reset();
            }
          }}
        >
          {EXCEPTION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {exceptionStatusLabels[value]}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="exceptions-type"
          label="Type"
          value={type ?? ''}
          onChange={(value) => {
            setType(isExceptionType(value) ? value : undefined);
            pages.reset();
          }}
        >
          <option value="">All types</option>
          {EXCEPTION_TYPES.map((value) => (
            <option key={value} value={value}>
              {exceptionTypeLabels[value]}
            </option>
          ))}
        </SelectField>
        <SiteSelect
          id="exceptions-site"
          label="Site"
          value={siteId}
          emptyLabel="All sites"
          onChange={(value) => {
            setSiteId(value);
            pages.reset();
          }}
        />
      </div>

      {exceptions.error ? (
        <LoadErrorAlert
          title="The queue could not be loaded"
          error={exceptions.error}
          retrying={exceptions.isFetching}
          onRetry={() => void exceptions.refetch()}
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
                <TableHead className="pl-4">When</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Site</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <ExceptionRows
                loading={exceptions.isPending}
                page={exceptions.data}
                siteNames={siteNames}
                filtered={type !== undefined || siteId !== '' || status !== 'OPEN'}
              />
            </TableBody>
          </Table>
        </Card>
      )}

      <PaginationNav pages={pages} nextCursor={nextCursor} busy={showingOldPage} />
    </div>
  );
}

interface ExceptionRowsProps {
  loading: boolean;
  page: AttendanceExceptionList | undefined;
  siteNames: Map<string, string>;
  filtered: boolean;
}

function ExceptionRows({ loading, page, siteNames, filtered }: ExceptionRowsProps) {
  if (loading) {
    return <TableLoadingRows colSpan={COLUMN_COUNT} label="Loading the queue…" />;
  }
  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow
        colSpan={COLUMN_COUNT}
        icon={ListChecks}
        title={filtered ? 'Nothing matches these filters.' : 'The queue is empty.'}
        hint={filtered ? 'Change a filter to see more.' : 'Every clock-in paired cleanly.'}
      />
    );
  }
  return page.items.map((exception) => (
    <TableRow key={exception.id}>
      <TableCell className="pl-4 tabular-nums">{formatDateTime(exception.occurredAt)}</TableCell>
      <TableCell>
        <ExceptionTypeBadge type={exception.type} />
      </TableCell>
      <TableCell>
        {exception.employee ? (
          <>
            {exception.employee.fullName}{' '}
            <span className="font-mono text-muted-foreground text-xs">
              {exception.employee.staffNumber}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            Device user {exception.punch?.deviceUserRef ?? '?'}
          </span>
        )}
      </TableCell>
      <TableCell className="whitespace-normal">
        {siteNames.get(exception.siteId) ?? 'Site'}
        {exception.secondSiteId && (
          <span className="text-muted-foreground">
            {' '}
            and {siteNames.get(exception.secondSiteId) ?? 'another site'}
          </span>
        )}
      </TableCell>
      <TableCell className="pr-4 text-right">
        <Link
          to={routes.exception(exception.id)}
          className="text-primary underline underline-offset-4 hover:no-underline"
        >
          Open
        </Link>
      </TableCell>
    </TableRow>
  ));
}
