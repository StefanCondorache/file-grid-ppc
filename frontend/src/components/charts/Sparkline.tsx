/** Tiny decorative trend line; the numbers always appear as text next to it. */
export function Sparkline({
  values,
  colorVar = '--fg-cat-meter',
  width = 96,
  height = 24,
}: {
  values: (number | null)[];
  colorVar?: string;
  width?: number;
  height?: number;
}) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return null;
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => (v === null ? null : `${(i * step).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline fill="none" stroke={`var(${colorVar})`} strokeWidth={2} points={points} />
    </svg>
  );
}
