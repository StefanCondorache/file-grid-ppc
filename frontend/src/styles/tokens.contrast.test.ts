// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, readTokens } from './contrast';

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
