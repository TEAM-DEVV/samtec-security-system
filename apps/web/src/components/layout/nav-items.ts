import type { UserRole } from '@samtec/contracts';
import {
  Activity,
  Clock,
  FileText,
  Home,
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
  /** One line for the overview page's cards. */
  description: string;
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
  {
    label: 'Overview',
    description: 'Where to start.',
    to: routes.home,
    icon: Home,
    phase: 1,
    available: true,
  },
  {
    label: 'Employees',
    description: 'Guards and staff on the payroll, with their posting and enrolment.',
    to: routes.employees,
    icon: Users,
    phase: 1,
    available: true,
    roles: pageRoles.employees,
  },
  {
    label: 'Sites',
    description: 'Client locations, who is on post, and which sites are active.',
    to: routes.sites,
    icon: MapPin,
    phase: 1,
    available: true,
    roles: pageRoles.sites,
  },
  {
    label: 'Attendance',
    description: 'Clock-ins paired into hours, with an exception queue.',
    to: '/attendance',
    icon: Clock,
    phase: 2,
    available: false,
  },
  {
    label: 'Payroll',
    description: 'Locked, audited pay runs with PAYE and SSNIT.',
    to: '/payroll',
    icon: Wallet,
    phase: 4,
    available: false,
  },
  {
    label: 'Ghost detection',
    description: 'Rules that catch pay without presence.',
    to: '/detection',
    icon: ShieldAlert,
    phase: 5,
    available: false,
  },
  {
    label: 'Reports',
    description: 'CSV and PDF exports.',
    to: '/reports',
    icon: FileText,
    phase: 6,
    available: false,
  },
  {
    label: 'System status',
    description: 'Whether the dashboard can reach the API and the API its database.',
    to: routes.status,
    icon: Activity,
    phase: 0,
    available: true,
  },
];

/** The sidebar items this role may see. With no role (nobody signed in), only the pages open to everyone. */
export function navItemsFor(role: UserRole | null): NavItem[] {
  return navItems.filter(
    (item) => item.roles === undefined || (role !== null && roleAllowed(item.roles, role)),
  );
}
