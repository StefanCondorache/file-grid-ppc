import type { ReactNode } from 'react';

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-2 rounded-panel border border-dashed border-input bg-surface-2 p-6">
      <h2 className="text-lg font-bold">{title}</h2>
      {body && <p className="text-ink-2">{body}</p>}
      {action}
    </section>
  );
}
