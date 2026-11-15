import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

/** One control card of the control room: a heading, a lead line and the controls. */
export function Panel({ title, lead, children, id }: { title: string; lead?: string; children: ReactNode; id: string }) {
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-3 p-5">
      <h3 id={id} className="text-lg font-bold">
        {title}
      </h3>
      {lead && <p className="text-sm text-ink-2">{lead}</p>}
      {children}
    </Card>
  );
}
