import type { ReactNode } from 'react';

/** One control card of the control room: a heading, a lead line and the controls. */
export function Panel({ title, lead, children, id }: { title: string; lead?: string; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-card border border-border bg-card p-5 shadow-e1">
      <h3 id={id} className="text-lg font-bold">
        {title}
      </h3>
      {lead && <p className="text-sm text-ink-2">{lead}</p>}
      {children}
    </section>
  );
}
