import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Garanții de business · FileGrid' };

/** Temporary board; slice 6e replaces it with the four guarantee cards. */
export default function GuaranteesPage() {
  return (
    <section aria-labelledby="board-title" className="flex flex-col gap-2">
      <h2 id="board-title" className="text-[22px] font-bold">Cele 4 garanții, acum</h2>
      <p className="text-ink-2">Panoul garanțiilor apare în etapa 6e.</p>
    </section>
  );
}
