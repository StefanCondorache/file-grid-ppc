'use client';

import type { ReactNode } from 'react';
import { AlertBanner } from '@/features/guarantees/AlertBanner';
import { UploadTray } from '@/features/upload/UploadTray';
import type { Me } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { Footer } from './Footer';
import { LiveBridge } from './LiveBridge';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/** Global chrome (frontend-architecture §1). Feature-owned pieces are placeholders replaced in place by their slices. */
export function AppShell({ me, children, onLogout }: { me: Me; children: ReactNode; onLogout?: () => void }) {
  const t = useT();
  return (
    <div className="grid min-h-screen grid-cols-[72px_1fr] lg:grid-cols-[264px_1fr]">
      <a href="#main" className="sr-only z-50 rounded-pill bg-surface px-4 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        {t.common.skipToContent}
      </a>
      <Sidebar me={me} />
      <div className="flex min-w-0 flex-col">
        <TopBar me={me} onLogout={onLogout} />
        <AlertBanner />
        <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 p-8">
          {children}
        </main>
        <Footer />
      </div>
      <UploadTray />
      <LiveBridge />
    </div>
  );
}
