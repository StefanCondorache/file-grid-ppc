import type { DestinationStream } from 'pino';

export interface MemoryLogDestination extends DestinationStream {
  lines(): Record<string, unknown>[];
}

/** A pino destination that keeps every JSON line in memory. */
export function memoryLogDestination(): MemoryLogDestination {
  const chunks: string[] = [];
  return {
    write(chunk: string): void {
      chunks.push(chunk);
    },
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
