import type { Metadata } from 'next';
import { ObservabilityScreen } from '@/features/observability/ObservabilityScreen';

export const metadata: Metadata = { title: 'Observabilitate · FileGrid' };

/** SC-07 Observabilitate: the category × storage matrix (`?window=5m|1h|24h`). */
export default function ObservabilityPage() {
  return <ObservabilityScreen />;
}
