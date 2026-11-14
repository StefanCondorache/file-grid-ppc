import type { Selectable } from 'kysely';
import type { UploadSessionsTable } from '../database/schema';

export type SessionRow = Selectable<UploadSessionsTable>;

/** Inclusive 1-based ranges: [1, 2, 3, 5] -> [[1, 3], [5, 5]]. */
export function toRanges(numbers: readonly number[]): [number, number][] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const n of sorted) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

export function missingParts(partCount: number, received: readonly number[]): number[] {
  const have = new Set(received);
  return Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !have.has(n));
}

export function expectedPartSize(
  session: Pick<SessionRow, 'file_size' | 'chunk_size' | 'part_count'>,
  part: number,
): number {
  const size = Number(session.file_size);
  return part < session.part_count
    ? session.chunk_size
    : size - session.chunk_size * (session.part_count - 1);
}

export function sessionView(session: SessionRow, received: readonly number[], maxFileSize: number) {
  return {
    uploadId: session.id,
    status: session.status,
    chunkSize: session.chunk_size,
    partCount: session.part_count,
    maxParallel: session.max_parallel,
    policyVersion: session.policy_version,
    maxFileSize,
    expiresAt: session.expires_at.toISOString(),
    displayName: session.display_name,
    receivedRanges: toRanges(received),
  };
}

export function statusView(
  session: SessionRow,
  parts: readonly { part_number: number; size_bytes: number }[],
) {
  return {
    uploadId: session.id,
    status: session.status,
    category: session.category,
    fileSize: Number(session.file_size),
    chunkSize: session.chunk_size,
    partCount: session.part_count,
    receivedRanges: toRanges(parts.map((p) => p.part_number)),
    receivedBytes: parts.reduce((sum, p) => sum + p.size_bytes, 0),
    policyVersion: session.policy_version,
    expiresAt: session.expires_at.toISOString(),
    startedAsRole: session.started_as_role,
    result: session.result,
    error: session.error,
  };
}
