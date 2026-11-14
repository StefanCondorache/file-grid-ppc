import type { Metadata } from 'next';
import { PoliciesScreen } from '@/features/policies/PoliciesScreen';

export const metadata: Metadata = { title: 'Politici · FileGrid' };

export default function Page() {
  return <PoliciesScreen />;
}
