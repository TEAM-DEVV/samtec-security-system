import type { WorkSegmentList } from '@samtec/contracts';
import { cn } from 'cn';
import { Clock } from 'lucide-react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { SegmentStatusBadge } from '@/components/attendance-badges';
import { useSiteNames } from '@/components/site-select';
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
import { segmentBasisLabels } from '@/lib/attendance';
import { formatDate, formatMinutes, formatTime } from '@/lib/format';

interface SegmentsTableProps {
  loading: boolean;
  page: WorkSegmentList | undefined;
  /** True while the table still shows the previous page and the new one is loading. */
  busy: boolean;
  /** Hidden on "My attendance", where every row is the same person. */
  showEmployee?: boolean;
  /** True when a filter is set, so the empty message can say so. */
  filtered: boolean;
  /** Who may open employee records; guards get plain text instead of a link. */
  linkEmployees?: boolean;
}

/** Worked shifts, one per row: the day view and "My attendance" share it. */
export function SegmentsTable({
  loading,
  page,
  busy,
  showEmployee = true,
  filtered,
  linkEmployees = true,
}: SegmentsTableProps) {
  const siteNames = useSiteNames();
  const columnCount = showEmployee ? 8 : 7;

  return (
    <Card
      aria-busy={busy}
      className={cn(
        'overflow-hidden rounded-2xl py-0 transition-opacity motion-safe:animate-rise-soft',
        busy && 'opacity-60',
      )}
    >
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50 [&_th]:text-[11px] [&_th]:text-muted-foreground [&_th]:uppercase [&_th]:tracking-[0.14em]">
            <TableHead className="pl-4">Date</TableHead>
            {showEmployee && <TableHead>Employee</TableHead>}
            <TableHead>Site</TableHead>
            <TableHead>In</TableHead>
            <TableHead>Out</TableHead>
            <TableHead className="text-right">Hours</TableHead>
            <TableHead>Proof</TableHead>
            <TableHead className="pr-4">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableLoadingRows colSpan={columnCount} label="Loading shifts…" />
          ) : !page || page.items.length === 0 ? (
            <TableEmptyRow
              colSpan={columnCount}
              icon={Clock}
              title={filtered ? 'No shifts match these filters.' : 'No shifts in these days.'}
              hint="Shifts appear once a clock-in has been paired with its clock-out."
            />
          ) : (
            page.items.map((segment) => (
              <TableRow key={segment.id}>
                <TableCell className="pl-4 tabular-nums">{formatDate(segment.workDate)}</TableCell>
                {showEmployee && (
                  <TableCell className="font-medium">
                    {linkEmployees ? (
                      <Link
                        to={routes.employee(segment.employee.id)}
                        className="text-primary underline underline-offset-4 hover:no-underline"
                      >
                        {segment.employee.fullName}
                      </Link>
                    ) : (
                      segment.employee.fullName
                    )}{' '}
                    <span className="font-mono text-muted-foreground text-xs">
                      {segment.employee.staffNumber}
                    </span>
                  </TableCell>
                )}
                <TableCell>{siteNames.get(segment.siteId) ?? 'Site'}</TableCell>
                <TableCell className="tabular-nums">{formatTime(segment.startedAt)}</TableCell>
                <TableCell className="tabular-nums">{formatTime(segment.endedAt)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMinutes(segment.workedMinutes)}
                </TableCell>
                <TableCell
                  className={cn(
                    segment.basis !== 'BIOMETRIC' && 'text-amber-800 dark:text-amber-300',
                  )}
                >
                  {segmentBasisLabels[segment.basis]}
                </TableCell>
                <TableCell className="pr-4">
                  <SegmentStatusBadge status={segment.status} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
