import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { qk, STREAM_FED_KEYS } from '@/lib/api/query-keys';
import { ro } from '@/lib/i18n/ro';
import type { StreamEvent } from './events';

type Deps = { announce: (message: string) => void; uploadHint: (uploadId: string) => void };
type Row = Record<string, unknown>;

const ANNOUNCE_WINDOW_MS = 5_000;
const INVALIDATE_EVERY_MS = 1_000;
const POLL_MS = 3_000;

/** Applies stream events to the TanStack cache (FA-8: events are snapshots or hints; REST is the source). */
export function createBridge(qc: QueryClient, deps: Deps) {
  let paused = false;
  const buffered = new Map<string, StreamEvent>();
  let faults: Row[] = [];
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let filesCooldown: ReturnType<typeof setTimeout> | null = null;
  let filesDirty = false;

  const invalidate = (queryKey: QueryKey) => void qc.invalidateQueries({ queryKey });

  const invalidateFilesThrottled = () => {
    if (filesCooldown) {
      filesDirty = true;
      return;
    }
    invalidate(qk.files.all);
    filesCooldown = setTimeout(() => {
      filesCooldown = null;
      if (filesDirty) {
        filesDirty = false;
        invalidateFilesThrottled();
      }
    }, INVALIDATE_EVERY_MS);
  };

  const queueFaultAnnouncement = (f: Row) => {
    faults.push(f);
    if (announceTimer) return;
    announceTimer = setTimeout(() => {
      const batch = faults;
      faults = [];
      announceTimer = null;
      if (batch.length === 1) {
        const [one] = batch;
        deps.announce(ro.live.newFault(ro.live.zones[String(one!.zone)] ?? String(one!.zone ?? ''), String(one!.substation ?? '')));
      } else if (batch.length > 1) {
        deps.announce(ro.live.newFaults(batch.length));
      }
    }, ANNOUNCE_WINDOW_MS);
  };

  const upsertAlert = (alert: Row) => {
    qc.setQueryData(qk.alerts, (old: { data: Row[]; meta?: unknown } | undefined) => {
      const rest = (old?.data ?? []).filter((a) => a.id !== alert.id);
      return { ...(old ?? {}), data: [alert, ...rest] };
    });
  };

  const applyNow = (e: StreamEvent) => {
    const d = (e.data ?? {}) as Row;
    switch (e.type) {
      case 'ping':
        return;
      case 'meters.counters':
        qc.setQueryData(qk.meters.counters, d);
        return;
      case 'guarantees.status':
        qc.setQueryData(qk.guarantees, { data: d.items });
        return;
      case 'storage.health':
        qc.setQueryData(qk.health, { data: d.items });
        return;
      case 'simulator.status':
        qc.setQueryData(qk.meters.simulator, d);
        return;
      case 'alert.raised':
      case 'alert.updated':
        upsertAlert(d);
        return;
      case 'file.created':
        invalidateFilesThrottled();
        if (d.category === 'fault') queueFaultAnnouncement(d);
        return;
      case 'file.integrity':
        invalidate(qk.files.detail(String(d.fileId)));
        invalidateFilesThrottled();
        return;
      case 'upload.verified':
        deps.uploadHint(String(d.uploadId));
        return;
      case 'policy.updated':
        invalidate(qk.policies.all);
        return;
      case 'demo.storm':
        invalidate(qk.demo.status);
        return;
    }
  };

  return {
    apply(e: StreamEvent) {
      if (paused && e.type !== 'upload.verified') {
        buffered.set(e.type === 'alert.raised' || e.type === 'alert.updated' || e.type === 'file.created' ? `${e.type}:${e.id}` : e.type, e);
        return;
      }
      applyNow(e);
    },
    resync() {
      for (const key of STREAM_FED_KEYS) invalidate(key);
    },
    /** "Actualizări live" pause (A11Y-14): buffer, then apply the latest snapshot per event type. */
    setPaused(next: boolean) {
      paused = next;
      if (!next) {
        const pending = [...buffered.values()].sort((a, b) => a.id - b.id);
        buffered.clear();
        pending.forEach(applyNow);
      }
    },
    /** Fallback when SSE is unavailable (e.g. a bearer-only backend): refetch stream-fed keys every 3 s. */
    startPolling(): () => void {
      const id = setInterval(() => {
        if (!paused) for (const key of STREAM_FED_KEYS) invalidate(key);
      }, POLL_MS);
      return () => clearInterval(id);
    },
  };
}

export type Bridge = ReturnType<typeof createBridge>;
