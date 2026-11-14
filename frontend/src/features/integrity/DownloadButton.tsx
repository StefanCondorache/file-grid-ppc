'use client';

import { QueryClientContext } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { IntegrityBadge } from '@/features/files/IntegrityBadge';
import { announce } from '@/lib/a11y/announcer';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/query-keys';
import { useT } from '@/lib/i18n';
import { formatPercent } from '@/lib/i18n/format';
import { downloadAndVerify, type VerifiedDownloadResult } from '@/lib/integrity/verify';

type Props = {
  fileId: string;
  /** Display-safe name (never personal data); used for the accessible label and as a fallback file name. */
  fileName: string;
  size: number;
  storage?: string | null;
  expectedSha256?: string | null;
  hasFallbackCopy?: boolean;
};

type State =
  | { s: 'idle' }
  | { s: 'running'; bytes: number }
  | { s: 'done'; result: VerifiedDownloadResult }
  | { s: 'error'; message: string; traceId: string | null };

function Hash({ label, value }: { label: string; value: string | null }) {
  const t = useT();
  return (
    <div className="grid gap-0.5">
      <dt className="text-ink-2">{label}</dt>
      <dd className="font-mono text-[12px] break-all text-ink tabular-nums">{value ?? t.integrity.unknown}</dd>
    </div>
  );
}

function ResultPanel({ result }: { result: VerifiedDownloadResult }) {
  const t = useT();
  const corrupt = result.state === 'corrupt';
  const body = corrupt ? t.integrity.corruptBody : result.state === 'server_verified' ? t.integrity.verifiedServer : t.integrity.verifiedClient;
  return (
    <div className="mt-1.5 grid max-w-[22rem] gap-1.5 text-[13px]">
      <IntegrityBadge state={result.state} />
      <p className="text-ink-2">{body}</p>
      <details open={corrupt} className="rounded-control border border-border bg-surface-2 px-2 py-1.5">
        <summary className="cursor-pointer font-semibold text-ink">{t.integrity.hashes}</summary>
        <dl className="mt-1.5 grid gap-1.5">
          <Hash label={t.integrity.expected} value={result.expectedSha256} />
          <Hash label={t.integrity.actual} value={result.actualSha256} />
          {result.storage && (
            <div className="flex gap-1.5">
              <dt className="text-ink-2">{t.integrity.storage}</dt>
              <dd className="font-semibold">{t.files.storage[result.storage as keyof typeof t.files.storage] ?? result.storage.toUpperCase()}</dd>
            </div>
          )}
          {result.traceId && (
            <div className="flex flex-wrap gap-1.5">
              <dt className="text-ink-2">{t.integrity.trace}</dt>
              <dd className="font-mono text-[12px] break-all">{result.traceId}</dd>
            </div>
          )}
          {result.nextStep && (
            <div className="flex flex-wrap gap-1.5">
              <dt className="text-ink-2">{t.integrity.nextStep}</dt>
              <dd className="font-semibold text-crit-ink">{t.integrity.next[result.nextStep]}</dd>
            </div>
          )}
        </dl>
      </details>
    </div>
  );
}

/**
 * Download with re-verification (FE-04, Task 6c.8): ≤ 64 MiB hashed in the browser, larger files verified by the
 * server and labelled so. The result stays under the button with both hashes; a corrupt file is never saved.
 */
export function DownloadButton({ fileId, fileName, size, storage, expectedSha256, hasFallbackCopy = false }: Props) {
  const t = useT();
  // Optional: the files table is also rendered on its own (tests, stories) without a provider.
  const queryClient = useContext(QueryClientContext);
  const [state, setState] = useState<State>({ s: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function start() {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ s: 'running', bytes: 0 });
    try {
      const result = await downloadAndVerify({
        fileId,
        size,
        expectedSha256,
        fileName,
        storage,
        hasFallbackCopy,
        signal: ac.signal,
        onProgress: (bytes) => setState({ s: 'running', bytes }),
      });
      if (ac.signal.aborted) return;
      setState({ s: 'done', result });
      announce(result.badge, result.state === 'corrupt' ? 'assertive' : 'polite');
      // The backend marks a corrupt file and records a verification: refresh the list's integrity column.
      void queryClient?.invalidateQueries({ queryKey: qk.files.all });
    } catch (e) {
      if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
        setState({ s: 'idle' });
        announce(t.integrity.cancelled);
        return;
      }
      const message = e instanceof ApiError && e.status > 0 ? e.message : t.integrity.failed;
      setState({ s: 'error', message, traceId: e instanceof ApiError ? e.traceId : null });
      announce(message, 'assertive');
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }

  const running = state.s === 'running';
  const pct = running && size > 0 ? formatPercent(Math.min(1, state.bytes / size), 0) : null;

  return (
    <div className="min-w-[8rem]">
      <div className="flex items-center gap-1">
        <Button type="button" variant="secondary" size="sm" onClick={() => void start()} disabled={running} aria-label={t.integrity.downloadLabel(fileName)}>
          <Download aria-hidden="true" />
          {running && pct ? <span className="tabular-nums">{t.integrity.downloading(pct)}</span> : t.integrity.download}
        </Button>
        {running && (
          <Button type="button" variant="quiet" size="sm" onClick={() => abortRef.current?.abort()} aria-label={t.integrity.cancel} title={t.integrity.cancel}>
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      {state.s === 'done' && <ResultPanel result={state.result} />}
      {state.s === 'error' && (
        <p className="mt-1.5 max-w-[22rem] text-[13px] text-crit-ink">
          {state.message}
          {state.traceId && <span className="block font-mono text-[12px] text-ink-2">{`${t.integrity.trace}: ${state.traceId}`}</span>}
        </p>
      )}
    </div>
  );
}
