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

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** The roadmap phase that builds this page (docs/plan/07-roadmap.md). */
  phase: number;
  /** False until the page exists. Unavailable pages show which phase brings them. */
  available: boolean;
}

export const navItems: NavItem[] = [
  { label: 'System status', to: '/', icon: Activity, phase: 0, available: true },
  { label: 'Employees', to: '/employees', icon: Users, phase: 1, available: true },
  { label: 'Sites', to: '/sites', icon: MapPin, phase: 1, available: false },
  { label: 'Attendance', to: '/attendance', icon: Clock, phase: 2, available: false },
  { label: 'Payroll', to: '/payroll', icon: Wallet, phase: 4, available: false },
  { label: 'Ghost detection', to: '/detection', icon: ShieldAlert, phase: 5, available: false },
  { label: 'Reports', to: '/reports', icon: FileText, phase: 6, available: false },
];
