import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { Button } from './ui/button';

/** Permission state (direction.md §10): explains the boundary and offers a safe way back. */
export function Forbidden({ roleLabel }: { roleLabel: string }) {
  const t = useT();
  return (
    <section className="flex flex-col items-start gap-3 rounded-panel glass-card p-6" aria-labelledby="forbidden-title">
      <h2 id="forbidden-title" className="text-[22px] font-bold">
        {t.common.forbiddenTitle}
      </h2>
      <p className="text-ink-2">{t.common.forbiddenBody(roleLabel)}</p>
      <Button asChild variant="secondary">
        <Link href="/">{t.common.backHome}</Link>
      </Button>
    </section>
  );
}
