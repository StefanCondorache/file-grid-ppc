import type { ReactNode } from 'react';
import { ro } from '@/lib/i18n/ro';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen grid-rows-[1fr_auto]">
      <main id="main" className="enter mx-auto grid w-full max-w-[1200px] items-center gap-12 px-8 py-12 lg:grid-cols-[minmax(0,1fr)_480px]">
        <section className="hidden min-h-[420px] overflow-hidden rounded-hero glass-card tilt-soft p-10 lg:block" aria-label={ro.auth.welcome}>
          <h2 className="text-gradient max-w-[440px] text-[40px] leading-tight font-bold tracking-tight">{ro.auth.welcome}</h2>
          <p className="mt-5 max-w-[420px] text-[17px] text-ink-2">{ro.auth.welcomeBody}</p>
        </section>
        <div className="glass-strong glass-edge rounded-hero border p-9 shadow-e3">{children}</div>
      </main>
      <footer className="glass flex justify-between border-t px-8 py-4 text-[13px] text-ink-2">
        <span>{ro.common.footer}</span>
        <span>{ro.common.footerTagline}</span>
      </footer>
    </div>
  );
}
