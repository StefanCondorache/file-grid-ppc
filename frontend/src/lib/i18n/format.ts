const NBSP = '\u00A0';

function num(value: number, fractionDigits: number): string {
  return new Intl.NumberFormat('ro-RO', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
    .format(value)
    .replace(/\./g, NBSP);
}

export function formatInt(n: number): string {
  return num(Math.round(n), 0);
}

export function formatBytes(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) {
    const gb = bytes / GB;
    return `${num(gb, gb < 10 ? 2 : 1)}${NBSP}GB`;
  }
  if (bytes >= MB) return `${num(bytes / MB, 1)}${NBSP}MB`;
  if (bytes >= KB) return `${num(bytes / KB, 1)}${NBSP}KB`;
  return `${formatInt(bytes)}${NBSP}B`;
}

export function formatPercent(ratio: number, digits = 1): string {
  return `${num(ratio * 100, digits)}${NBSP}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${formatInt(ms)}${NBSP}ms`;
  return `${num(ms / 1000, 1)}${NBSP}s`;
}

const dateTime = new Intl.DateTimeFormat('ro-RO', {
  timeZone: 'Europe/Bucharest',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}
