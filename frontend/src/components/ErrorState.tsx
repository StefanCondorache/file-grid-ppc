'use client';

import { CircleAlert, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/errors';
import { useT } from '@/lib/i18n';

/** One safe error view (SR-18): Romanian message by code, code and trace ID, never the raw server text. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  const e = error instanceof ApiError ? error : new ApiError(0, 'UNKNOWN', 'unknown');
  const messages = t.errors as Record<string, string>;
  const message = messages[e.code] ?? t.errors.generic;
  return (
    <section className="flex flex-col gap-3 rounded-panel border border-crit bg-crit-tint p-5 text-ink" aria-label={message}>
      <h2 className="flex items-center gap-2 text-lg font-bold text-crit-ink">
        <CircleAlert aria-hidden="true" className="size-5" />
        {message}
      </h2>
      <p className="flex flex-wrap items-center gap-1 text-sm text-ink-2">
        <span>
          {t.common.errorCode}: <span className="font-mono">{e.code}</span>
        </span>
        {e.traceId && (
          <>
            <span aria-hidden="true">·</span>
            <span>{t.errors.traceId}</span>
            <span className="font-mono">{e.traceId}</span>
            <Button
              variant="quiet"
              size="sm"
              aria-label={t.common.copyTraceId}
              onClick={() => void navigator.clipboard?.writeText(e.traceId ?? '')}
            >
              <Copy aria-hidden="true" />
            </Button>
          </>
        )}
      </p>
      {onRetry && (
        <div>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t.common.retry}
          </Button>
        </div>
      )}
    </section>
  );
}
