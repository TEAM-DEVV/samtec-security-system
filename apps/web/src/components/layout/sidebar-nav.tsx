import { cn } from 'cn';
import { NavLink } from 'react-router';
import type { NavItem } from './nav-items';

interface SidebarNavProps {
  items: NavItem[];
  /** Called when a link is chosen, so the mobile menu can close itself. */
  onNavigate?: () => void;
}

/** The list of pages, used both in the sidebar and in the mobile menu. */
export function SidebarNav({ items, onNavigate }: SidebarNavProps) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 px-3">
      {items.map((item) =>
        item.available ? (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md border-l-2 border-transparent px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                isActive &&
                  'border-sidebar-primary bg-sidebar-accent font-medium text-sidebar-accent-foreground',
              )
            }
          >
            <item.icon aria-hidden="true" className="size-4 shrink-0" />
            {item.label}
          </NavLink>
        ) : (
          <span
            key={item.to}
            aria-disabled="true"
            className="flex cursor-not-allowed items-center gap-3 rounded-md border-l-2 border-transparent px-3 py-2 text-sidebar-foreground/70 text-sm"
          >
            <item.icon aria-hidden="true" className="size-4 shrink-0" />
            {item.label}
            <span className="sr-only">(coming in Phase {item.phase})</span>
            <span
              aria-hidden="true"
              className="ml-auto rounded-full border border-sidebar-border px-1.5 py-0.5 font-medium text-[10px]"
            >
              P{item.phase}
            </span>
          </span>
        ),
      )}
    </nav>
  );
}
