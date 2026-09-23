import type { ReactNode } from 'react';
import { useLocation } from 'react-router';

/**
 * Plays a short rise-in whenever the address changes, so moving between
 * pages feels like one continuous app rather than a series of reloads. The
 * `key` makes React mount a fresh element per page, which restarts the
 * animation. People who prefer reduced motion see the page appear at once.
 *
 * It remounts the whole page on each path change. For routes that share a
 * parent layout (for example tabs inside one record), move it into the leaf
 * route instead, or the parent's state would be thrown away on every tab.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <div key={pathname} className="motion-safe:animate-rise-soft">
      {children}
    </div>
  );
}
