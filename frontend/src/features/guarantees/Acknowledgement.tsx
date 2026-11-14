'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { announce } from '@/lib/a11y/announcer';
import { useT } from '@/lib/i18n';
import type { Alert } from '@/lib/monitoring/contract';
import { useAcknowledgeAlert } from './queries';

const clock = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit' });

/** "15:33" in Romanian time, or null for a timestamp that does not parse. */
export function timeOf(iso: string | null): string | null {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? clock.format(at) : null;
}

/**
 * Who acknowledged an alert and when ("Confirmată de Elena Marin la 15:33"), or the "Confirmă" button that records it
 * (FE-07). After a successful click, focus moves to the confirmation that replaces the button, so it is not lost.
 */
export function Acknowledgement({ alert, guarantee }: { alert: Alert; guarantee: string }) {
  const t = useT().monitoring.alerts;
  const ack = useAcknowledgeAlert();
  const doneRef = useRef<HTMLSpanElement>(null);
  const focusWhenDone = useRef(false);
  const time = timeOf(alert.acknowledgedAt);

  useEffect(() => {
    if (time === null || !focusWhenDone.current) return;
    focusWhenDone.current = false;
    doneRef.current?.focus();
  }, [time]);

  if (time !== null) {
    return (
      <span ref={doneRef} tabIndex={-1} className="text-sm text-ink-2">
        {alert.acknowledgedBy ? t.acknowledged(alert.acknowledgedBy.displayName, time) : t.acknowledgedAt(time)}
      </span>
    );
  }

  const onClick = () => {
    if (ack.isPending) return;
    focusWhenDone.current = true;
    ack.mutate(alert.id, {
      onError: () => {
        focusWhenDone.current = false;
        announce(t.acknowledgeFailed(guarantee), 'assertive');
      },
    });
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="secondary" size="sm" aria-label={t.acknowledgeLabel(guarantee)} aria-busy={ack.isPending} onClick={onClick}>
        {t.acknowledge}
      </Button>
      {ack.isError && <span className="text-sm font-semibold text-crit-ink">{t.acknowledgeFailedShort}</span>}
    </span>
  );
}
