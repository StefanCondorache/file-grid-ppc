// Fails on raw colour literals outside the token file: every colour must come from src/styles/tokens.css.
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from './check-diacritics.mjs';

const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/g;

export function findColorLiterals(text) {
  return [...text.matchAll(COLOR)].map((m) => m[0]);
}

const ALLOWED = [['src', 'styles', 'tokens.css'].join(sep), ['src', 'mocks', ''].join(sep)];

function main() {
  const problems = [];
  for (const file of walk('src', ['.ts', '.tsx', '.css'])) {
    const rel = relative('.', file);
    if (ALLOWED.some((a) => rel === a || rel.startsWith(a))) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const c of findColorLiterals(line)) problems.push(`${rel}:${i + 1}: raw colour ${c}, use a token`);
    });
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
