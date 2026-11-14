import type { Metadata } from 'next';
import { LoginScreen } from '@/features/auth/LoginScreen';

export const metadata: Metadata = { title: 'Autentificare · FileGrid' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string }> }) {
  const sp = await searchParams;
  return <LoginScreen next={sp.next ?? null} reason={sp.reason ?? null} />;
}
