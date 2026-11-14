'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark } from '@/components/Wordmark';
import type { Me } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { isCurrent, NAV } from './nav';

export function Sidebar({ me }: { me: Me }) {
  const t = useT();
  const pathname = usePathname();
  const items = NAV.filter((n) => n.visible(me));
  const groups = [...new Set(items.map((n) => n.group))];
  return (
    <nav aria-label={t.shell.mainNav} className="sticky top-0 flex h-screen w-[72px] flex-col glass-chrome px-3 py-5 text-sidebar-foreground lg:w-[264px]">
      <Link href="/" className="mb-5 flex items-center gap-2.5 px-2.5 text-sidebar-foreground no-underline">
        <Wordmark onDark />
        <span className="hidden lg:block">
          <b className="block text-xl font-bold tracking-tight">FileGrid</b>
          <small className="block text-[11px] text-(--fg-on-chrome-2)">{t.shell.tagline}</small>
        </span>
      </Link>
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-0.5">
          <div className="mx-2.5 mt-4 mb-1.5 hidden text-[11px] font-semibold tracking-wider text-(--fg-on-chrome-2) uppercase lg:block">
            {t.shell.groups[g]}
          </div>
          {items
            .filter((n) => n.group === g)
            .map((n) => {
              const current = isCurrent(n.href, pathname);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'relative flex min-h-10 items-center gap-3 rounded-[10px] px-3 py-2.5 text-[15px] text-sidebar-foreground no-underline transition-colors duration-(--fg-dur-fast) hover:bg-(--fg-chrome-2)',
                    current && 'bg-(--fg-chrome-2) font-semibold before:absolute before:top-2 before:bottom-2 before:-left-3 before:w-1 before:rounded-r before:bg-brand-orange',
                  )}
                >
                  <n.icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
                  <span className="hidden truncate lg:inline">{n.label}</span>
                  <span className="sr-only lg:hidden">{n.label}</span>
                </Link>
              );
            })}
        </div>
      ))}
    </nav>
  );
}
