/** WCAG 2.x contrast helpers used by the token test (A11Y-7). */

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function block(css: string, selector: RegExp): string {
  const start = css.search(selector);
  if (start < 0) return '';
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

/** Hex tokens of a theme: `light` = top-level :root; `dispecerat` = :root overridden by its block. */
export function readTokens(css: string, theme: 'light' | 'dispecerat'): Record<string, string> {
  const pick = (text: string) =>
    Object.fromEntries([...text.matchAll(/(--fg-[\w-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1]!, m[2]!.toUpperCase()]));
  const light = pick(block(css, /^:root \{/m));
  return theme === 'light' ? light : { ...light, ...pick(block(css, /^\[data-theme="dispecerat"\] \{/m)) };
}

/** `fg` painted at `alpha` over `bg`, composited per sRGB channel the way browsers blend. */
export function over(fg: string, alpha: number, bg: string): string {
  const ch = (hex: string, i: number) => parseInt(hex.replace('#', '').slice(i, i + 2), 16);
  const mixed = [0, 2, 4].map((i) => Math.round(alpha * ch(fg, i) + (1 - alpha) * ch(bg, i)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** Numeric tokens of a theme (`--fg-glass-alpha: 0.5`), with the same light/dispecerat layering as readTokens. */
export function readNumbers(css: string, theme: 'light' | 'dispecerat'): Record<string, number> {
  const pick = (text: string) =>
    Object.fromEntries([...text.matchAll(/(--fg-[\w-]+):\s*(\d*\.?\d+);/g)].map((m) => [m[1]!, Number(m[2])]));
  const light = pick(block(css, /^:root \{/m));
  return theme === 'light' ? light : { ...light, ...pick(block(css, /^\[data-theme="dispecerat"\] \{/m)) };
}
