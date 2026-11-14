import { Suspense, type ReactNode } from 'react';
import { AuthGate } from '@/features/shell/AuthGate';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense>
      <AuthGate>{children}</AuthGate>
    </Suspense>
  );
}
