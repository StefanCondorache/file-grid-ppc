/** FileGrid wordmark: a 3×3 grid of chunks filling up, the last two landing in brand orange (direction.md §8). */
export function Wordmark({ size = 30, onDark = false }: { size?: number; onDark?: boolean }) {
  const cells = Array.from({ length: 9 }, (_, k) => {
    const fill = k >= 7 ? 'var(--fg-brand-orange)' : k % 2 ? 'var(--fg-brand-cyan)' : onDark ? 'var(--fg-on-chrome)' : 'var(--fg-brand-dark)';
    return <rect key={k} x={(k % 3) * 10 + 1} y={Math.floor(k / 3) * 10 + 1} width={8} height={8} rx={2} fill={fill} />;
  });
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
      {cells}
    </svg>
  );
}
