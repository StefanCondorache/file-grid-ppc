import type { Metadata } from 'next';
import { TraceScreen } from '@/features/integrity/TraceScreen';

export const metadata: Metadata = { title: 'Trasare · FileGrid' };

export default async function Page({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  return <TraceScreen traceId={traceId} />;
}
