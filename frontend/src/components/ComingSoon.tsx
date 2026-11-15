/** Empty state for screens without data yet; each slice replaces its own page.tsx. */
export function ComingSoon({ title }: { title: string; slice?: string }) {
  return (
    <section aria-labelledby="soon-title" className="flex flex-col gap-2 rounded-panel glass-card glass-empty p-7">
      <h2 id="soon-title" className="text-[22px] font-bold">{title}</h2>
      <p className="text-ink-2">Nu există încă date de afișat.</p>
    </section>
  );
}
