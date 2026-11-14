// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBuildGuard, checkMockGuard } from './mock-guard';

describe('production mock guard', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('blocks a production build with mocks on unless explicitly allowed', () => {
    expect(checkMockGuard({ NEXT_PUBLIC_API_MOCKS: '1' })).toMatch(/mocks/i);
    expect(checkMockGuard({ NEXT_PUBLIC_API_MOCKS: '1', FILEGRID_ALLOW_MOCKS: '1' })).toBeNull();
    expect(checkMockGuard({})).toBeNull();
  });

  it('fails when .env.local sets NEXT_PUBLIC_API_MOCKS=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-guard-'));
    writeFileSync(join(dir, '.env.local'), 'NEXT_PUBLIC_API_MOCKS=1\n');
    delete process.env.NEXT_PUBLIC_API_MOCKS;
    // The guard runs during `next build`; Next skips .env.local when NODE_ENV=test.
    (process.env as Record<string, string>).NODE_ENV = 'production';
    expect(checkBuildGuard(dir)).toMatch(/mocks/i);
  });
});
