import type { Metadata } from 'next';
import { AuditScreen } from '@/features/audit/AuditScreen';

export const metadata: Metadata = { title: 'Jurnal de audit · FileGrid' };

export default function Page() {
  return <AuditScreen />;
}
