export function KpiTile({ label, value, unit, note }: { label: string; value: string; unit?: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold tracking-wide text-ink-2 uppercase">{label}</span>
      <span className="text-[36px] leading-tight font-bold tracking-tight">
        {value}
        {unit && <span className="ml-1 text-lg font-semibold text-ink-2">{unit}</span>}
      </span>
      {note && <span className="text-sm text-ink-2">{note}</span>}
    </div>
  );
}
