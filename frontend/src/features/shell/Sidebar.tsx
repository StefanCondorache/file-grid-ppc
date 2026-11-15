'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLayoutEffect, useRef } from 'react';
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
  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  // Decorative: slide the single glowing indicator onto the current item (re-measured on resize: group labels
  // only show at lg). Hidden when no item is current.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const ind = indicatorRef.current;
    if (!nav || !ind) return;
    let frame = 0;
    const place = () => {
      const link = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!link) {
        delete ind.dataset.ready;
        return;
      }
      ind.style.setProperty('--fg-nav-y', `${link.offsetTop}px`);
      ind.style.setProperty('--fg-nav-h', `${link.offsetHeight}px`);
      if (!('ready' in ind.dataset)) frame = requestAnimationFrame(() => (ind.dataset.ready = ''));
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', place);
    };
  }, [pathname]);

  return (
    <nav ref={navRef} aria-label={t.shell.mainNav} className="sticky top-0 flex h-screen w-[72px] flex-col glass-chrome px-3 py-5 text-sidebar-foreground lg:w-[264px]">
      <span ref={indicatorRef} aria-hidden="true" className="nav-indicator" />
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
                    'relative flex min-h-10 items-center gap-3 rounded-[10px] px-3 py-2.5 text-[15px] text-sidebar-foreground no-underline hover:bg-(--fg-chrome-2)',
                    current && 'font-semibold',
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
