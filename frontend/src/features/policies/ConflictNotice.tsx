'use client';

import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import type { PolicyView } from '@/lib/upload/contract';
import type { DiffRow } from './DiffDialog';

export function ConflictNotice({ current, rows, onReload }: { current: PolicyView; rows: DiffRow[]; onReload: () => void }) {
  const t = useT().policies;
  return (
    <section role="alert" className="flex flex-col gap-3 rounded-panel border border-warn-border bg-warn-tint p-4 text-warn-ink">
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <TriangleAlert aria-hidden="true" className="size-5" />
        {t.conflictTitle}
      </h2>
      <p>{t.conflictBody(current.updatedBy.displayName, current.version)}</p>
      {rows.length > 0 && (
        <>
          <p className="font-semibold">{t.conflictDiff}</p>
          <ul className="list-disc pl-5 text-sm">
            {rows.map((r) => (
              <li key={r.field}>{r.field}: {r.from} → {r.to}</li>
            ))}
          </ul>
        </>
      )}
      <div>
        <Button variant="secondary" size="sm" onClick={onReload}>{t.conflictReload}</Button>
      </div>
    </section>
  );
}
