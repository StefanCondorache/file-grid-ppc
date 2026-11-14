import type { Metadata } from 'next';
import { AuditRoute } from '@/features/audit/AuditRoute';

export const metadata: Metadata = { title: 'Jurnal de audit · FileGrid' };

export default function Page() {
  return <AuditRoute />;
}
