// Retry timing: exponential backoff with full jitter, and the HTTP Retry-After header.

import type { Rng } from './readings.ts';

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 15_000;
/** A Retry-After above this is treated as this value, so a broken header cannot stall the sender for hours. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Delay before retry number `failures` (1 = first retry): uniform in [0, min(cap, base * 2^(failures-1))]. */
export function fullJitterDelay(failures: number, rng: Rng, baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  return Math.floor(rng() * Math.min(capMs, baseMs * 2 ** exponent));
}

/** Parses Retry-After (delay in seconds, or an HTTP date) into milliseconds; undefined when absent or invalid. */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  if (!/^[A-Za-z]{3}/.test(value)) return undefined; // every HTTP-date form starts with the day name
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - nowMs), MAX_RETRY_AFTER_MS);
}
