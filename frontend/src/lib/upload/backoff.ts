/** Full-jitter exponential backoff (upload-engine.md §6, UE-8): a uniform delay in [0, min(cap, base·2^attempt)]. */
export function backoffMs(attempt: number, rng: () => number, base = 1000, cap = 30_000): number {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.floor(rng() * ceiling);
}

/** Deterministic PRNG (mulberry32) for tests and reproducible property runs. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
