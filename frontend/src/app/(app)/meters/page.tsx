import type { Metadata } from 'next';
import { MetersScreen } from '@/features/meters/MetersScreen';

export const metadata: Metadata = { title: 'Contoare live · FileGrid' };

/** SC-04 Contoare live: counters, rate, zones and the newest readings. */
export default function MetersPage() {
  return <MetersScreen />;
}
