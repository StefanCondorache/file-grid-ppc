import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import { makeQueryClient } from './query-client';

describe('makeQueryClient', () => {
  const retry = makeQueryClient().getDefaultOptions().queries?.retry as (n: number, e: unknown) => boolean;

  it('never retries 4xx, retries 5xx and network errors twice', () => {
    expect(retry(0, new ApiError(404, 'NOT_FOUND', 'x'))).toBe(false);
    expect(retry(0, new ApiError(503, 'STORAGE_UNAVAILABLE', 'x'))).toBe(true);
    expect(retry(1, new ApiError(0, 'NETWORK', 'x'))).toBe(true);
    expect(retry(2, new ApiError(503, 'STORAGE_UNAVAILABLE', 'x'))).toBe(false);
  });

  it('does not refetch on window focus (no demo jumps)', () => {
    expect(makeQueryClient().getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });
});
