import type { Metadata } from 'next';
import { ComingSoon } from '@/components/ComingSoon';

export const metadata: Metadata = { title: 'Jurnal de audit · FileGrid' };

/** Placeholder until slice 6h replaces this page. */
export default function Page() {
  return <ComingSoon title="Jurnal de audit" slice="6h" />;
}
