'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { useT } from '@/lib/i18n';
import { TraceWaterfall, useTrace } from './TraceWaterfall';

/** `/traces/[traceId]`: one operation on its own page, with a way back to the file it touched. */
export function TraceScreen({ traceId }: { traceId: string }) {
  const t = useT();
  const fileId = useTrace(traceId).data?.fileId ?? null;
  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-[28px] leading-tight font-bold tracking-tight">{t.files.trace.pageTitle}</h2>
      <Card className="flex flex-col gap-4">
        <TraceWaterfall traceId={traceId} />
      </Card>
      {fileId && (
        <Link href={`/files/${encodeURIComponent(fileId)}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-link hover:underline">
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t.files.detail.back}
        </Link>
      )}
    </div>
  );
}
