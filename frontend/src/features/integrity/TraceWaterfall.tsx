'use client';

import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Button, buttonVariants } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/status-chip';
import { announce } from '@/lib/a11y/announcer';
import { api, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/query-keys';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { formatDateTime, formatDuration } from '@/lib/i18n/format';

/** One step, as `GET /traces/{traceId}` sends it (docs/api.md "Monitoring and traces"). */
export type TraceSpan = {
  spanId: string;
  name: string;
  startOffsetMs: number;
  durationMs: number;
  status: 'ok' | 'error';
  storage: string | null;
  errorCode: string | null;
};

export type Trace = {
  traceId: string;
  operation: string;
  category: string | null;
  fileId: string | null;
  storage: string | null;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error';
  spans: TraceSpan[];
};

/** The backend accepts and echoes trace ids of this shape only (X-Trace-Id). */
export const TRACE_ID = /^[A-Za-z0-9-]{1,64}$/;

export async function fetchTrace(traceId: string): Promise<Trace> {
  if (!TRACE_ID.test(traceId)) throw new ApiError(404, 'NOT_FOUND', 'Invalid trace id');
  // The path follows docs/api.md; the generated proposal types differ, so the body is checked here.
  const body = (await unwrap(api.GET('/traces/{traceId}', { params: { path: { traceId } } }))) as unknown as Partial<Trace> | null;
  if (!body || typeof body.traceId !== 'string' || !Array.isArray(body.spans)) {
    throw new ApiError(0, 'BAD_RESPONSE', 'Unexpected trace from the server');
  }
  return body as Trace;
}

export function useTrace(traceId: string) {
  return useQuery({ queryKey: qk.traces.one(traceId), queryFn: () => fetchTrace(traceId), staleTime: 60_000 });
}

/**
 * Grafana, where the backend logs of this trace can be read (dashboard "FileGrid overview", variable `trace_id`).
 * `NEXT_PUBLIC_GRAFANA_URL` when set, otherwise `/grafana`: on the VPS Grafana is served under that sub-path of the
 * same host (deploy/k8s/observability/grafana-values.yaml).
 */
export function grafanaTraceUrl(traceId: string): string {
  const base = (process.env.NEXT_PUBLIC_GRAFANA_URL || '/grafana').replace(/\/+$/, '');
  return `${base}/d/filegrid-overview?var-trace_id=${encodeURIComponent(traceId)}&from=now-7d&to=now`;
}

const pct = (n: number) => `${Math.min(100, Math.max(0, n * 100)).toFixed(2)}%`;

export function TraceActions({ traceId }: { traceId: string }) {
  const t = useT();
  const copy = () => void navigator.clipboard?.writeText(traceId).then(() => announce(t.files.trace.copied));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-ink-2">{t.files.trace.traceId}</span>
      <code translate="no" className="rounded-control bg-sunken px-2 py-1 font-mono text-[13px] [overflow-wrap:anywhere]">
        {traceId}
      </code>
      <Button variant="quiet" size="sm" aria-label={t.files.trace.copy} title={t.files.trace.copy} onClick={copy}>
        <Copy aria-hidden="true" />
      </Button>
      <a href={grafanaTraceUrl(traceId)} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
        <ExternalLink aria-hidden="true" />
        {t.files.trace.grafana}
      </a>
    </div>
  );
}

/** The steps of one trace as a table, each with a bar placed at its offset and sized by its duration. */
export function TraceTable({ trace }: { trace: Trace }) {
  const t = useT();
  const tr = t.files.trace;
  const spans = [...trace.spans].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  const total = Math.max(trace.durationMs, ...spans.map((s) => s.startOffsetMs + s.durationMs), 0);
  if (spans.length === 0) return <p className="text-sm text-ink-2">{tr.noSpans}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <caption className="sr-only">{tr.caption}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs font-semibold tracking-wide text-ink-2 uppercase">
            <th scope="col" className="py-2 pr-3">{tr.cols.step}</th>
            <th scope="col" className="py-2 pr-3">{tr.cols.storage}</th>
            <th scope="col" className="py-2 pr-3 text-right">{tr.cols.start}</th>
            <th scope="col" className="py-2 pr-3 text-right">{tr.cols.duration}</th>
            <th scope="col" className="w-2/5 py-2">
              <span className="sr-only">{tr.cols.timeline}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {spans.map((s) => {
            const failed = s.status === 'error';
            return (
              <tr key={s.spanId} data-status={s.status} className="border-b border-border last:border-b-0">
                <td className="py-2.5 pr-3">
                  <span className="font-semibold">{tr.spans[s.name] ?? s.name}</span>
                  {failed && (
                    <span className="ml-2 font-semibold text-crit-ink">
                      {tr.spanError}
                      {s.errorCode && <code className="ml-1 font-mono text-xs">{s.errorCode}</code>}
                    </span>
                  )}
                </td>
                <td className="py-2.5 pr-3">{s.storage ? (t.files.storage[s.storage as keyof typeof t.files.storage] ?? s.storage.toUpperCase()) : tr.noStorage}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{formatDuration(s.startOffsetMs)}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{formatDuration(s.durationMs)}</td>
                <td className="py-2.5" aria-hidden="true">
                  <div className="relative h-2.5 rounded-full bg-sunken">
                    <div
                      data-bar
                      className={cn('absolute top-0 h-full min-w-[3px] rounded-full', failed ? 'bg-crit' : 'bg-info')}
                      style={{ left: pct(total > 0 ? s.startOffsetMs / total : 0), width: pct(total > 0 ? s.durationMs / total : 0) }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A trace loaded by id: summary line, actions (copy, Grafana) and the steps table (FE-05). */
export function TraceWaterfall({ traceId }: { traceId: string }) {
  const t = useT();
  const tr = t.files.trace;
  const query = useTrace(traceId);
  if (query.isPending) {
    return (
      <p aria-busy="true" className="text-sm text-ink-2">
        {tr.loading}
      </p>
    );
  }
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) return <EmptyState title={tr.notFound} body={tr.notFoundBody} />;
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  const trace = query.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <StatusChip tone={trace.status === 'error' ? 'crit' : 'ok'} label={tr.status[trace.status] ?? trace.status} />
        <span className="font-semibold">{tr.operations[trace.operation] ?? trace.operation}</span>
        <span className="text-sm text-ink-2 tabular-nums">
          {tr.total}: {formatDuration(trace.durationMs)} · {tr.startedAt}{' '}
          <time dateTime={trace.startedAt}>{formatDateTime(trace.startedAt)}</time>
        </span>
      </div>
      <TraceActions traceId={trace.traceId} />
      <TraceTable trace={trace} />
    </div>
  );
}
