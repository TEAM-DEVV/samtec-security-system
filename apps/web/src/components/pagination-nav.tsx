import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CursorPages } from '@/lib/cursor-pages';

interface PaginationNavProps {
  pages: CursorPages;
  /** The `nextCursor` the API sent: `null` disables Next on the last page. */
  nextCursor: string | null;
  /** True while a page is loading, so a second click never skips a page. */
  busy: boolean;
}

/** The Previous / Next bar under every list, wired to `useCursorPages`. */
export function PaginationNav({ pages, nextCursor, busy }: PaginationNavProps) {
  return (
    <nav aria-label="Pagination" className="flex items-center justify-end gap-2">
      <Button variant="outline" size="sm" disabled={!pages.canGoBack} onClick={pages.goBack}>
        <ChevronLeft aria-hidden="true" />
        Previous
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={nextCursor === null}
        onClick={() => pages.goForward(nextCursor, busy)}
      >
        Next
        <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  );
}
