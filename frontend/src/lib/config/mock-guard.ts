import { loadEnvConfig } from '@next/env';

type Env = Record<string, string | undefined>;

/** Error text when a production build would ship mocks without the explicit demo-day allowance. */
export function checkMockGuard(env: Env): string | null {
  if (env.NEXT_PUBLIC_API_MOCKS === '1' && env.FILEGRID_ALLOW_MOCKS !== '1') {
    return 'Refusing a production build with mocks on (NEXT_PUBLIC_API_MOCKS=1). Set FILEGRID_ALLOW_MOCKS=1 only for the documented demo-day fallback image.';
  }
  return null;
}

/** Loads .env* files like `next build` does (prebuild scripts would miss them), then checks. */
export function checkBuildGuard(dir: string = process.cwd()): string | null {
  loadEnvConfig(dir, false, { info: () => {}, error: console.error }, true);
  return checkMockGuard(process.env);
}
