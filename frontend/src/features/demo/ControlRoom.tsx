'use client';

import { CircleCheck, CircleX } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Forbidden } from '@/components/Forbidden';
import { Card } from '@/components/ui/card';
import { useMe } from '@/features/auth/queries';
import { roleLabel } from '@/features/auth/roles';
import { announce } from '@/lib/a11y/announcer';
import { can } from '@/lib/auth/capabilities';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { call, ReportContext, useDemoStatus, useRunAction, useSimulator, type LogEntry } from './api';
import { ConfirmAction } from './ConfirmAction';
import { CorruptControl } from './CorruptControl';
import { EffectPanel } from './EffectPanel';
import { Panel } from './Panel';
import { SimulatorControl } from './SimulatorControl';
import { StorageControl } from './StorageControl';
import { StormControl } from './StormControl';
import { TerminalHelp } from './TerminalHelp';

const clock = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Back to normal: stop the storm, normal simulator rate, S3 and FTP started; each step reported. */
function ResetControl() {
  const t = useT().demo;
  const run = useRunAction();
  const reset = async () => {
    const steps: [string, () => Promise<unknown>][] = [
      [t.storm.stop, () => call('DELETE', '/demo/storms/meter_readings')],
      [t.simulator.normal, () => call('PUT', '/meters/simulator', { mode: 'normal' })],
      [t.storage.start('S3'), () => call('POST', '/demo/storages/s3/start')],
      [t.storage.start('FTP'), () => call('POST', '/demo/storages/ftp/start')],
    ];
    await run(
      async () => {
        const failed: string[] = [];
        for (const [name, step] of steps) await step().catch(() => failed.push(name));
        if (failed.length === steps.length) throw new Error('reset failed');
        return failed;
      },
      (failed) => (failed.length ? t.reset.partial(failed.join(', ')) : t.reset.done),
    );
  };
  return (
    <Panel id="reset-title" title={t.reset.title} lead={t.reset.lead}>
      <div>
        <ConfirmAction variant="secondary" label={t.reset.action} title={t.reset.confirmTitle} body={t.reset.confirmBody} onConfirm={reset} />
      </div>
    </Panel>
  );
}

function ActionLog({ entries }: { entries: LogEntry[] }) {
  const t = useT().demo.log;
  return (
    <Card aria-labelledby="log-title" className="flex flex-col gap-2 p-5">
      <h3 id="log-title" className="text-lg font-bold">
        {t.title}
      </h3>
      {entries.length === 0 ? (
        <p className="text-sm text-ink-2">{t.empty}</p>
      ) : (
        <ol className="flex max-h-56 flex-col gap-2 overflow-y-auto" data-testid="action-log">
          {entries.map((e) => (
            <li key={e.id} data-ok={e.ok} className={cn('flex items-start gap-2 text-sm', e.ok ? 'text-ink' : 'text-crit-ink')}>
              {e.ok ? <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ok-ink" /> : <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
              <span className="tabular-nums text-ink-2">{e.at}</span>
              <span>
                <span className="sr-only">{e.ok ? t.ok : t.failed}: </span>
                {e.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * Cameră de control (SC-10, FE-12; admin in demo mode): big buttons wired to the real demo endpoints, each behind an
 * in-page confirmation, the result log, and the effect on the same screen.
 */
export function ControlRoom() {
  const t = useT().demo;
  const me = useMe();
  const allowed = !!me.data && me.data.demoMode && can(me.data, 'demo_controls');
  const status = useDemoStatus(allowed);
  const simulator = useSimulator(allowed);
  const [log, setLog] = useState<LogEntry[]>([]);

  const report = useCallback((ok: boolean, text: string) => {
    setLog((prev) => [{ id: Date.now() + Math.random(), at: clock.format(new Date()), ok, text }, ...prev].slice(0, 30));
    announce(text, ok ? 'polite' : 'assertive');
  }, []);

  if (me.data && !allowed) return <Forbidden roleLabel={roleLabel(me.data.activeRole)} />;

  const sim = simulator.data ?? status.data?.simulator ?? null;

  return (
    <ReportContext.Provider value={report}>
      <div className="flex flex-col gap-8">
        <div className="flex max-w-3xl flex-col gap-1">
          <h2 className="text-[22px] font-bold">{t.title}</h2>
          <p className="text-ink-2">{t.lead}</p>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          <StormControl status={status.data} simulator={sim} />
          <StorageControl />
          <CorruptControl />
          <SimulatorControl simulator={sim} unavailable={simulator.isError} />
          <ResetControl />
          <ActionLog entries={log} />
        </div>
        <TerminalHelp />
        <EffectPanel />
      </div>
    </ReportContext.Provider>
  );
}
