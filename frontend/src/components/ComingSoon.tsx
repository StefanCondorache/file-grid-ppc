/** Placeholder for routes whose slice is not built yet; each slice replaces its own page.tsx. */
export function ComingSoon({ title, slice }: { title: string; slice: string }) {
  return (
    <section aria-labelledby="soon-title" className="flex flex-col gap-2 rounded-panel border border-dashed border-input bg-surface-2 p-6">
      <h2 id="soon-title" className="text-[22px] font-bold">{title}</h2>
      <p className="text-ink-2">Ecranul acesta este în lucru (etapa {slice} din plan).</p>
    </section>
  );
}
