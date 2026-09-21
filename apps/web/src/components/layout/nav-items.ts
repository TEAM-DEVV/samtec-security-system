import type { UserRole } from '@samtec/contracts';
import {
  Activity,
  Clock,
  FileText,
  type LucideIcon,
  MapPin,
  ShieldAlert,
  Users,
  Wallet,
} from 'lucide-react';
import { routes } from '@/app/routes';
import { pageRoles, roleAllowed } from '@/lib/roles';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** The roadmap phase that builds this page (docs/plan/07-roadmap.md). */
  phase: number;
  /** False until the page exists. Unavailable pages show which phase brings them. */
  available: boolean;
  /** Who may open the page. Left out: everyone who is signed in. */
  roles?: readonly UserRole[];
}

export const navItems: NavItem[] = [
  { label: 'System status', to: '/', icon: Activity, phase: 0, available: true },
  {
    label: 'Employees',
    to: routes.employees,
    icon: Users,
    phase: 1,
    available: true,
    roles: pageRoles.employees,
  },
  {
    label: 'Sites',
    to: routes.sites,
    icon: MapPin,
    phase: 1,
    available: true,
    roles: pageRoles.sites,
  },
  { label: 'Attendance', to: '/attendance', icon: Clock, phase: 2, available: false },
  { label: 'Payroll', to: '/payroll', icon: Wallet, phase: 4, available: false },
  { label: 'Ghost detection', to: '/detection', icon: ShieldAlert, phase: 5, available: false },
  { label: 'Reports', to: '/reports', icon: FileText, phase: 6, available: false },
];

/** The sidebar items this role may see. With no role (nobody signed in), only the pages open to everyone. */
export function navItemsFor(role: UserRole | null): NavItem[] {
  return navItems.filter(
    (item) => item.roles === undefined || (role !== null && roleAllowed(item.roles, role)),
  );
}
