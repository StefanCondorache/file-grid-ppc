'use client';

import { useMe } from '@/features/auth/queries';
import { AuditScreen } from './AuditScreen';

/** Page entry: AuthGate has already loaded `me`, so this only reads it from the cache. */
export function AuditRoute() {
  const me = useMe();
  return me.data ? <AuditScreen me={me.data} /> : null;
}
