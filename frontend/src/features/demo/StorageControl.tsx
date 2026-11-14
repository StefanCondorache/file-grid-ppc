'use client';

import { StatusChip, type Tone } from '@/components/ui/status-chip';
import { useStorageHealth } from '@/features/health/queries';
import { useT } from '@/lib/i18n';
import type { StorageStatus } from '@/lib/monitoring/contract';
import { call, useRunAction } from './api';
import { ConfirmAction } from './ConfirmAction';
import { Panel } from './Panel';

const CONTROLLED = ['s3', 'ftp'] as const;
const TONE: Record<StorageStatus, Tone> = { ok: 'ok', degraded: 'warn', down: 'crit' };

/**
 * Stop / start S3 or FTP (POST /demo/storages/{s3|ftp}/{stop|start}: the backend scales the StatefulSet). Postgres is
 * not offered: it also holds the metadata. When Kubernetes refuses, the result says so and TerminalHelp has the command.
 */
export function StorageControl() {
  const t = useT();
  const d = t.demo;
  const run = useRunAction();
  const health = useStorageHealth();

  return (
    <Panel id="storage-title" title={d.storage.title} lead={d.storage.lead}>
      <ul className="flex flex-col gap-4">
        {CONTROLLED.map((s) => {
          const name = d.storages[s];
          const h = health.data?.find((x) => x.storage === s);
          return (
            <li key={s} className="flex flex-wrap items-center gap-3">
              <span className="w-12 font-bold">{name}</span>
              {h ? (
                <StatusChip tone={TONE[h.status]} label={t.monitoring.health.states[h.status]} />
              ) : (
                <StatusChip tone="neutral" label={t.monitoring.health.states.unknown} />
              )}
              <ConfirmAction
                variant="danger"
                label={d.storage.stop(name)}
                title={d.storage.confirmStopTitle(name)}
                body={d.storage.confirmStopBody(name)}
                onConfirm={() => run(() => call('POST', `/demo/storages/${s}/stop`), () => d.storage.stopped(name))}
              />
              <ConfirmAction
                variant="primary"
                label={d.storage.start(name)}
                title={d.storage.confirmStartTitle(name)}
                body={d.storage.confirmStartBody(name)}
                onConfirm={() => run(() => call('POST', `/demo/storages/${s}/start`), () => d.storage.started(name))}
              />
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
