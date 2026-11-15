// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, over, readNumbers, readTokens } from './contrast';

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

describe.each(['light', 'dispecerat'] as const)('%s theme', (theme) => {
  const t = readTokens(css, theme);
  const ratio = (fg: string, bg: string) => contrastRatio(t[fg]!, t[bg]!);

  it('every functional pair meets WCAG AA', () => {
    expect(ratio('--fg-on-action', '--fg-action')).toBeGreaterThanOrEqual(4.5);
    for (const ink of ['--fg-ink', '--fg-ink-2', '--fg-ink-3']) expect(ratio(ink, '--fg-surface')).toBeGreaterThanOrEqual(4.5);
    for (const s of ['ok', 'crit', 'info', 'warn']) expect(ratio(`--fg-on-${s}`, `--fg-${s}`)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--fg-line-input', '--fg-surface')).toBeGreaterThanOrEqual(3);
    for (const c of ['meter', 'fault', 'connection', 'drone']) expect(ratio(`--fg-cat-${c}`, '--fg-surface')).toBeGreaterThanOrEqual(3);
  });
});

it('uses the chosen action orange', () => {
  expect(readTokens(css, 'light')['--fg-action']).toBe('#D04000');
});

// Glass over the animated mesh: worst case = every subset of blobs, stacked in every order at peak alpha, on either
// base colour. The blur only averages this, so passing here means passing wherever the blobs drift.
describe.each(['light', 'dispecerat'] as const)('%s glass over the backdrop', (theme) => {
  const t = readTokens(css, theme);
  const n = readNumbers(css, theme);
  const blobs = [1, 2, 3, 4].map((i) => t[`--fg-blob-${i}`]!);
  const orders = (xs: string[]): string[][] => (xs.length ? xs.flatMap((x, i) => orders(xs.filter((_, j) => j !== i)).map((o) => [x, ...o])) : [[]]);
  const subsets = blobs.reduce<string[][]>((acc, b) => acc.concat(acc.map((s) => [...s, b])), [[]]);
  const backdrops = [t['--fg-backdrop-1']!, t['--fg-backdrop-2']!].flatMap((base) =>
    subsets.flatMap(orders).map((stack) => stack.reduce((bg, b) => over(b, n['--fg-blob-alpha']!, bg), base)),
  );
  const glass = (alpha: number, scrim = false) =>
    backdrops.map((b) => over(t['--fg-glass-tint']!, alpha, scrim ? over(t['--fg-scrim-tint']!, n['--fg-scrim-alpha']!, b) : b));
  const surfaces = {
    card: glass(n['--fg-glass-alpha']!),
    table: glass(n['--fg-glass-dense-alpha']!),
    dialog: glass(n['--fg-glass-strong-alpha']!, true),
  };

  it('every glass ink keeps ≥ 4.5:1 on every glass surface', () => {
    for (const [name, bgs] of Object.entries(surfaces))
      for (const bg of bgs)
        for (const ink of ['--fg-ink', '--fg-glass-ink-2', '--fg-glass-ink-3', '--fg-glass-link'])
          expect(contrastRatio(t[ink]!, bg), `${ink} on ${name} ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('gradient headings (large text) keep ≥ 3:1 and the action gradient keeps its label ≥ 4.5:1', () => {
    for (const bg of surfaces.card)
      for (const stop of ['--fg-text-grad-1', '--fg-text-grad-2', '--fg-text-grad-3'])
        expect(contrastRatio(t[stop]!, bg), `${stop} on ${bg}`).toBeGreaterThanOrEqual(3);
    for (const bg of ['--fg-action-2', '--fg-action-2-hover']) expect(contrastRatio(t['--fg-on-action']!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});
