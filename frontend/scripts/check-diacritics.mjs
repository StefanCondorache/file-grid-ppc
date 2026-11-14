// Fails when Romanian text uses cedilla s/t (U+015E/015F/0162/0163) instead of comma-below.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CEDILLAS = /[\u015E\u015F\u0162\u0163]/g;

export function findCedillas(text) {
  return [...text.matchAll(CEDILLAS)].map((m) => m.index);
}

export function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(path);
  }
  return out;
}

function main() {
  const roots = ['src', 'tests'].filter((r) => { try { return statSync(r).isDirectory(); } catch { return false; } });
  const problems = [];
  for (const file of roots.flatMap((r) => walk(r, ['.ts', '.tsx', '.json', '.css', '.md']))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (findCedillas(line).length) problems.push(`${relative('.', file)}:${i + 1}: cedilla ş/ţ, use ș/ț`);
    });
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
