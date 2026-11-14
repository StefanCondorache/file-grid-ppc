'use client';

import { useRouter } from 'next/navigation';
import { Wordmark } from '@/components/Wordmark';
import { LoginForm } from './LoginForm';

export function LoginScreen({ next, reason }: { next: string | null; reason: string | null }) {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Wordmark size={34} />
        <b className="text-[22px]">FileGrid</b>
      </div>
      <LoginForm next={next} reason={reason} onLoggedIn={(path) => router.replace(path)} />
    </div>
  );
}
