import type { UserRole } from '@samtec/contracts';
import {
  Activity,
  CalendarClock,
  Clock,
  FileText,
  Home,
  ListChecks,
  type LucideIcon,
  MapPin,
  Radio,
  ReceiptText,
  ScanFace,
  ShieldAlert,
  TabletSmartphone,
  UserCog,
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
    description: 'Clock-ins paired into worked shifts, by day and site.',
    to: routes.attendance,
    icon: Clock,
    phase: 2,
    available: true,
    roles: pageRoles.attendance,
  },
  {
    label: 'My attendance',
    description: 'Your own clock-ins, paired into shifts.',
    to: routes.myAttendance,
    icon: CalendarClock,
    phase: 2,
    available: true,
    roles: ['GUARD'],
  },
  {
    label: 'Live board',
    description: 'Every clock-in as it arrives, refreshed every five seconds.',
    to: routes.liveBoard,
    icon: Radio,
    phase: 3,
    available: true,
    roles: pageRoles.liveBoard,
  },
  {
    label: 'Exceptions',
    description: 'Clock-ins that need a person: missing punches, unknown numbers, overlaps.',
    to: routes.exceptions,
    icon: ListChecks,
    phase: 2,
    available: true,
    roles: pageRoles.exceptions,
  },
  {
    label: 'Devices',
    description: 'The terminals and kiosks that record clock-ins, and their health.',
    to: routes.devices,
    icon: TabletSmartphone,
    phase: 2,
    available: true,
    roles: pageRoles.devices,
  },
  {
    label: 'Duplicate faces',
    description:
      'New faces that looked like someone already enrolled: a second administrator decides.',
    to: routes.duplicateFaces,
    icon: ScanFace,
    phase: 3,
    available: true,
    roles: pageRoles.duplicateFaces,
  },
  {
    label: 'Payroll',
    description: 'Locked, audited pay runs with PAYE and SSNIT.',
    to: routes.payroll,
    icon: Wallet,
    phase: 4,
    available: true,
    roles: pageRoles.payroll,
  },
  {
    label: 'My payslips',
    description: 'Your own pay, month by month, with the figures you can check.',
    to: routes.myPayslips,
    icon: ReceiptText,
    phase: 4,
    available: true,
    roles: pageRoles.payslips,
  },
  {
    label: 'Ghost detection',
    description: 'Rules that catch pay without presence.',
    to: routes.detection,
    icon: ShieldAlert,
    phase: 5,
    available: true,
    roles: pageRoles.detection,
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
    label: 'Users',
    description: 'Sign-in accounts: who can open the dashboard, and with which role.',
    to: routes.users,
    icon: UserCog,
    phase: 1,
    available: true,
    roles: pageRoles.users,
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
