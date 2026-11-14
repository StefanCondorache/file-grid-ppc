import type { Category, Policy, StorageLabel } from '@/lib/api/types';

/** Shared mock state (Task 5.9b). Handlers of every group read and write here, so cross-slice effects work. */
const KEY = 'fg.mock.db';
type StorageStatus = 'ok' | 'degraded' | 'down';
type Row = Record<string, unknown>;
type State = Record<string, Row[]> & { __storage?: never };

const SYSTEM = { id: 'u-admin', username: 'admin', displayName: 'Administrator', role: 'admin' as const };
const now = () => new Date().toISOString();

function policy(category: Category, version: number, primary: StorageLabel, fallback: StorageLabel | null, extra: Partial<Policy> = {}): Policy {
  return {
    category, version, primaryStorage: primary, fallbackStorage: fallback, encryptionAtRest: false, encryptionLocked: false,
    encryptionAlgorithm: null, chunkSize: 8 * 1024 * 1024, maxParallel: 4, maxFileSize: 4 * 1024 ** 3,
    allowedTypes: [], retentionDays: 365, updatedAt: now(), updatedBy: SYSTEM, ...extra,
  };
}

const BASE_SEEDS: Record<string, () => Row[]> = {
  policies: () => [
    policy('fault', 3, 'S3', 'FTP', { maxParallel: 2, maxFileSize: 50 * 1024 ** 2, allowedTypes: ['application/pdf', 'image/jpeg', 'image/png'] }),
    policy('drone', 3, 'S3', 'FTP', { allowedTypes: ['video/mp4', 'video/quicktime'] }),
    policy('connection', 2, 'DB', 'S3', { maxParallel: 2, maxFileSize: 20 * 1024 ** 2, encryptionAtRest: true, encryptionLocked: true, encryptionAlgorithm: 'AES-256-GCM', allowedTypes: ['application/pdf', 'image/jpeg', 'image/png'] }),
    policy('meter', 1, 'DB', null, { maxParallel: 1, maxFileSize: 64 * 1024, allowedTypes: ['application/json'] }),
  ] as unknown as Row[],
  storage: () => [{ name: 'S3', status: 'ok' }, { name: 'FTP', status: 'ok' }, { name: 'DB', status: 'ok' }],
  users: () => [], sessions: () => [], uploads: () => [], files: () => [], custody: () => [], audit: () => [], periods: () => [],
};

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function createDb(storage: KV | null = typeof window !== 'undefined' ? window.localStorage : null) {
  const seeds: Record<string, () => Row[]> = { ...BASE_SEEDS };
  const fresh = (): State => Object.fromEntries(Object.entries(seeds).map(([k, f]) => [k, f()])) as State;
  let state: State = (() => {
    const raw = storage?.getItem(KEY);
    return raw ? { ...fresh(), ...(JSON.parse(raw) as State) } : fresh();
  })();
  const save = () => storage?.setItem(KEY, JSON.stringify(state));

  const api = {
    register<T extends Row>(name: string, seed: T[] | (() => T[])) {
      seeds[name] = typeof seed === 'function' ? seed : () => structuredClone(seed);
      if (!state[name]) { state[name] = seeds[name]!(); save(); }
    },
    list<T = Row>(name: string): T[] { return (state[name] ?? []) as T[]; },
    find<T = Row>(name: string, pred: (row: T) => boolean): T | undefined { return api.list<T>(name).find(pred); },
    insert<T extends Row>(name: string, row: T): T { state[name] = [...(state[name] ?? []), row]; save(); return row; },
    update<T extends Row>(name: string, pred: (row: T) => boolean, patch: Partial<T>): T | undefined {
      let hit: T | undefined;
      state[name] = api.list<T>(name).map((r) => (pred(r) ? (hit = { ...r, ...patch }) : r));
      save();
      return hit;
    },
    reset() { state = fresh(); save(); },

    audit: { append: (e: Row) => api.insert('audit', { id: `a-${state.audit?.length ?? 0}-${Date.now()}`, at: now(), ...e }) },
    files: { insert: (f: Row) => api.insert('files', f) },
    custody: { append: (fileId: string, e: Row) => api.insert('custody', { id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: now(), fileId, ...e }) },
    policies: {
      get: (category: Category) => api.find<Policy>('policies', (p) => p.category === category),
      put: (p: Policy) => { state.policies = [...api.list<Row>('policies').filter((x) => x.category !== p.category), p as unknown as Row]; save(); return p; },
    },
    storage: {
      status: (name: StorageLabel) => (api.find<{ name: string; status: StorageStatus }>('storage', (s) => s.name === name)?.status ?? 'ok'),
      set: (name: StorageLabel, status: StorageStatus) => api.update<{ name: string; status: StorageStatus }>('storage', (s) => s.name === name, { status }),
    },
  };
  return api;
}

export type MockDb = ReturnType<typeof createDb>;
export const db = createDb();

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as unknown as { __fgMockReset?: () => void }).__fgMockReset = () => db.reset();
}
