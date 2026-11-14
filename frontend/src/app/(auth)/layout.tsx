import type { ReactNode } from 'react';
import { ro } from '@/lib/i18n/ro';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen grid-rows-[1fr_auto]">
      <main id="main" className="enter mx-auto grid w-full max-w-[1200px] items-center gap-12 px-8 py-12 lg:grid-cols-[minmax(0,1fr)_480px]">
        <section className="relative hidden min-h-[420px] overflow-hidden rounded-hero bg-chrome p-8 text-sidebar-foreground lg:block" aria-label={ro.auth.welcome}>
          <h2 className="max-w-[420px] text-[30px] leading-tight font-bold">{ro.auth.welcome}</h2>
          <p className="mt-4 max-w-[420px] text-[17px] text-(--fg-on-chrome-2)">{ro.auth.welcomeBody}</p>
        </section>
        <div className="glass-strong rounded-hero border p-9 shadow-e2">{children}</div>
      </main>
      <footer className="flex justify-between border-t border-border px-8 py-4 text-[13px] text-ink-2">
        <span>{ro.common.footer}</span>
        <span>{ro.common.footerTagline}</span>
      </footer>
    </div>
  );
}
