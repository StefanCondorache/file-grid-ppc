import { GROUPS, type Group } from '@/mocks/groups';

export type MockMode = 'off' | 'full' | 'hybrid';
export type MockConfig = { enabled: boolean; mode: MockMode; groups: Group[] | 'all' };
type Env = Partial<Record<'NODE_ENV' | 'NEXT_PUBLIC_API_MOCKS' | 'NEXT_PUBLIC_API_MOCK_GROUPS', string>>;

// Literal accesses so Next inlines the values into the browser bundle.
const buildEnv: Env = {
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_API_MOCKS: process.env.NEXT_PUBLIC_API_MOCKS,
  NEXT_PUBLIC_API_MOCK_GROUPS: process.env.NEXT_PUBLIC_API_MOCK_GROUPS,
};

/**
 * NEXT_PUBLIC_API_MOCKS: '1' mocks, '0' real backend, unset = mocks in development/test only.
 * NEXT_PUBLIC_API_MOCK_GROUPS: a subset → hybrid (in-page, no service worker); uploads/files are never mocked in hybrid.
 */
export function mockConfig(env: Env = buildEnv): MockConfig {
  const flag = env.NEXT_PUBLIC_API_MOCKS;
  const enabled = flag === '1' || (flag === undefined && (env.NODE_ENV === 'development' || env.NODE_ENV === 'test'));
  if (!enabled) return { enabled: false, mode: 'off', groups: [] };
  const listed = (env.NEXT_PUBLIC_API_MOCK_GROUPS ?? '').split(',').map((g) => g.trim()).filter(Boolean);
  const groups = GROUPS.filter((g) => listed.includes(g));
  if (groups.length === 0 || groups.length === GROUPS.length) return { enabled: true, mode: 'full', groups: 'all' };
  if (groups.includes('uploads') || groups.includes('files')) {
    throw new Error('uploads and files cannot be mocked in hybrid mode (XHR parts and plain download links bypass in-page mocks)');
  }
  return { enabled: true, mode: 'hybrid', groups };
}
