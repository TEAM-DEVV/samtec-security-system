import { useState } from 'react';

/** What `useCursorPages` gives a list page. */
export interface CursorPages {
  /** Send this as the `cursor` query parameter. Undefined on the first page. */
  cursor: string | undefined;
  /** False on the first page, so the Previous button can be disabled. */
  canGoBack: boolean;
  goBack: () => void;
  /**
   * Moves forward using the `nextCursor` the API sent (`null` on the last
   * page). Ignores the click while `busy` (a page is still loading), so one
   * click never skips a page; the button stays enabled, so keyboard users
   * never lose their place.
   */
  goForward: (nextCursor: string | null, busy: boolean) => void;
  /** Back to the first page. Call it whenever a search or filter changes. */
  reset: () => void;
}

/**
 * Cursor pagination for list pages, the way every SAMTEC list endpoint works:
 * the API returns one page and a `nextCursor` bookmark. This hook keeps the
 * bookmarks of every page visited, so Previous can walk back.
 */
export function useCursorPages(): CursorPages {
  // The cursor of every page visited so far. The last one is the current page.
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);

  return {
    cursor: cursors.at(-1),
    canGoBack: cursors.length > 1,
    goBack: () => setCursors((current) => (current.length > 1 ? current.slice(0, -1) : current)),
    goForward: (nextCursor, busy) => {
      if (nextCursor !== null && !busy) {
        setCursors((current) =>
          // A repeated push of the same bookmark would make Previous appear to
          // do nothing, so it is ignored.
          current.at(-1) === nextCursor ? current : [...current, nextCursor],
        );
      }
    },
    reset: () => setCursors([undefined]),
  };
}
