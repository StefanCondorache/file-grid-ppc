'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

/** One copy-paste command with its purpose. */
export function Command({ label, command }: { label: string; command: string }) {
  const t = useT().common;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <li className="flex flex-col gap-1">
      <span className="text-sm text-ink-2">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-control bg-sunken px-3 py-2 font-mono text-sm whitespace-nowrap">{command}</code>
        <Button variant="quiet" size="sm" onClick={copy} aria-label={`${copied ? t.copied : t.copy}: ${label}`}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
    </li>
  );
}

/** Controls the API does not expose: network degradation needs root on the k3s node (mk/chaos.mk). */
export const NETEM_ON_S3 = 'make chaos-netem-on NS=filegrid-storage POD=s3-0 DELAY=300ms LOSS=5%';
export const NETEM_OFF_S3 = 'make chaos-netem-off NS=filegrid-storage POD=s3-0';
export const NETEM_ON_FTP = 'make chaos-netem-on NS=filegrid-storage POD=ftp-0';
export const STORAGE_STOP_S3 = 'make chaos-storage-stop S=s3';
export const STORAGE_START_S3 = 'make chaos-storage-start S=s3';

export function TerminalHelp() {
  const t = useT().demo.terminal;
  return (
    <section aria-labelledby="terminal-title" className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 p-5">
      <h3 id="terminal-title" className="text-lg font-bold">
        {t.title}
      </h3>
      <p className="text-sm text-ink-2">{t.lead}</p>
      <ul className="flex flex-col gap-3">
        <Command label={t.netemOn} command={NETEM_ON_S3} />
        <Command label={t.netemOff} command={NETEM_OFF_S3} />
        <Command label={t.netemFtp} command={NETEM_ON_FTP} />
      </ul>
      <details>
        <summary className="cursor-pointer text-sm font-semibold text-link">{t.storageTitle}</summary>
        <ul className="mt-3 flex flex-col gap-3">
          <Command label={t.storageStop} command={STORAGE_STOP_S3} />
          <Command label={t.storageStart} command={STORAGE_START_S3} />
        </ul>
      </details>
    </section>
  );
}
