export const GROUPS = ['auth', 'policies', 'uploads', 'files', 'audit', 'meters', 'monitoring', 'statistics', 'demo', 'stream'] as const;
export type Group = (typeof GROUPS)[number];

const ROOTS: Record<string, Group> = {
  auth: 'auth', policies: 'policies', uploads: 'uploads', ping: 'uploads', files: 'files', traces: 'files',
  'audit-events': 'audit', 'meter-readings': 'meters', meters: 'meters', guarantees: 'monitoring', alerts: 'monitoring',
  'storage-health': 'monitoring', metrics: 'monitoring', statistics: 'statistics', demo: 'demo', stream: 'stream',
};

/** Endpoint group of a path relative to API_BASE ("/files/x" → files); null when unknown. */
export function pathGroup(path: string): Group | null {
  const root = path.replace(/^\/+/, '').split(/[/?]/)[0] ?? '';
  return ROOTS[root] ?? null;
}
