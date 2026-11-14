import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config/config';

const MAX_TRACKED_KEYS = 10_000;

/**
 * Blocks an (ip, username) key after LOGIN_MAX_FAILURES failed logins inside LOGIN_WINDOW_S.
 * In memory, per instance: enough to stop password guessing against one replica.
 */
@Injectable()
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.maxFailures = config.loginMaxFailures;
    this.windowMs = config.loginWindowS * 1000;
  }

  /** Throws 429 while the key is blocked. */
  check(key: string): void {
    const recent = this.recent(key);
    if (recent.length < this.maxFailures) return;
    const retryAfterS = Math.max(1, Math.ceil((recent[0] + this.windowMs - Date.now()) / 1000));
    throw new AppError(
      429,
      'RATE_LIMITED',
      'Prea multe încercări eșuate. Încercați din nou mai târziu.',
      { retryAfterMs: retryAfterS * 1000 },
      { 'Retry-After': String(retryAfterS) },
    );
  }

  recordFailure(key: string): void {
    if (!this.failures.has(key) && this.failures.size >= MAX_TRACKED_KEYS) {
      const oldest = this.failures.keys().next();
      if (!oldest.done) this.failures.delete(oldest.value);
    }
    this.failures.set(key, [...this.recent(key), Date.now()]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = Date.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((time) => time > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }
}
