import type { LucideIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableRow } from '@/components/ui/table';

interface TableLoadingRowsProps {
  /** How many columns the table has, so the skeletons span the full width. */
  colSpan: number;
  /** What a screen reader announces, for example "Loading employees…". */
  label: string;
  rows?: number;
}

/** Grey placeholder rows while the first page loads. */
export function TableLoadingRows({ colSpan, label, rows = 5 }: TableLoadingRowsProps) {
  return Array.from({ length: rows }, (_, index) => (
    // Placeholder rows have no identity of their own, so the index is a fine key.
    // biome-ignore lint/suspicious/noArrayIndexKey: see above
    <TableRow key={index}>
      <TableCell colSpan={colSpan} className="px-4 py-3">
        {index === 0 && (
          <span role="status" className="sr-only">
            {label}
          </span>
        )}
        <Skeleton aria-hidden="true" className="h-5 w-full" />
      </TableCell>
    </TableRow>
  ));
}

interface TableEmptyRowProps {
  colSpan: number;
  icon: LucideIcon;
  title: string;
  /** One helpful sentence, for example "Clear a filter to see more." */
  hint?: string;
}

/** The friendly face of an empty table: an icon, what is empty, and what to do. */
export function TableEmptyRow({ colSpan, icon: Icon, title, hint }: TableEmptyRowProps) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="py-14">
        <div className="flex flex-col items-center gap-2 text-center motion-safe:animate-rise-soft">
          <span className="rounded-2xl bg-primary/8 p-3 text-primary">
            <Icon aria-hidden="true" className="size-5" />
          </span>
          <p className="font-heading font-medium text-base">{title}</p>
          {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
        </div>
      </TableCell>
    </TableRow>
  );
}
