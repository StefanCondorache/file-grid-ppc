import { Activity, ChartColumn, ClipboardList, Files, Gauge, House, SlidersHorizontal, Upload, Zap, type LucideIcon } from 'lucide-react';
import type { Me } from '@/lib/api/types';
import { can } from '@/lib/auth/capabilities';
import { ro } from '@/lib/i18n/ro';

export type NavItem = { href: string; label: string; icon: LucideIcon; group: keyof typeof ro.shell.groups; visible: (me: Me) => boolean };

const any = (me: Me, ...caps: Parameters<typeof can>[1][]) => caps.some((c) => can(me, c));

export const NAV: NavItem[] = [
  { href: '/', label: ro.shell.nav.guarantees, icon: House, group: 'monitoring', visible: () => true },
  { href: '/meters', label: ro.shell.nav.meters, icon: Gauge, group: 'monitoring', visible: (me) => can(me, 'view_meters') },
  { href: '/observability', label: ro.shell.nav.observability, icon: Activity, group: 'monitoring', visible: (me) => can(me, 'view_observability') },
  { href: '/statistics', label: ro.shell.nav.statistics, icon: ChartColumn, group: 'monitoring', visible: (me) => can(me, 'view_statistics') },
  { href: '/upload', label: ro.shell.nav.upload, icon: Upload, group: 'files', visible: (me) => any(me, 'upload_drone', 'upload_fault', 'upload_connection') },
  { href: '/files', label: ro.shell.nav.files, icon: Files, group: 'files', visible: (me) => any(me, 'view_drone', 'view_fault', 'view_connection', 'view_meters') },
  { href: '/policies', label: ro.shell.nav.policies, icon: SlidersHorizontal, group: 'admin', visible: (me) => any(me, 'edit_policies', 'view_audit') },
  { href: '/audit', label: ro.shell.nav.audit, icon: ClipboardList, group: 'admin', visible: (me) => can(me, 'view_audit') },
  { href: '/demo', label: ro.shell.nav.demo, icon: Zap, group: 'demo', visible: (me) => me.demoMode && can(me, 'demo_controls') },
];

export function isCurrent(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function titleFor(pathname: string): string {
  return NAV.find((n) => isCurrent(n.href, pathname))?.label ?? ro.common.appName;
}
