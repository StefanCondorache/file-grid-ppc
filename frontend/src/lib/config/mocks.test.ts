import { describe, expect, it } from 'vitest';
import { mockConfig } from './mocks';

describe('mockConfig', () => {
  it('defaults to full mocks in development and test, off in production', () => {
    expect(mockConfig({ NODE_ENV: 'development' })).toMatchObject({ enabled: true, mode: 'full' });
    expect(mockConfig({ NODE_ENV: 'test' })).toMatchObject({ enabled: true, mode: 'full' });
    expect(mockConfig({ NODE_ENV: 'production' })).toMatchObject({ enabled: false, mode: 'off' });
  });

  it('NEXT_PUBLIC_API_MOCKS=0 switches to the real backend, 1 forces mocks', () => {
    expect(mockConfig({ NODE_ENV: 'development', NEXT_PUBLIC_API_MOCKS: '0' }).mode).toBe('off');
    expect(mockConfig({ NODE_ENV: 'production', NEXT_PUBLIC_API_MOCKS: '1' }).mode).toBe('full');
  });

  it('a group list selects hybrid mode', () => {
    expect(mockConfig({ NODE_ENV: 'development', NEXT_PUBLIC_API_MOCK_GROUPS: 'statistics, monitoring' }))
      .toMatchObject({ mode: 'hybrid', groups: ['monitoring', 'statistics'] });
  });

  it('refuses to mock uploads or files in hybrid mode', () => {
    expect(() => mockConfig({ NODE_ENV: 'development', NEXT_PUBLIC_API_MOCK_GROUPS: 'statistics,uploads' }))
      .toThrow('uploads and files cannot be mocked in hybrid mode');
  });
});
