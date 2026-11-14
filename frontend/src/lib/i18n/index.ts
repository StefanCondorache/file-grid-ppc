import { formatInt } from './format';
import { ro } from './ro';

export type Catalog = typeof ro;

/** The active catalogue. Romanian only at P0 (FE-16); English would be selected here. */
export function useT(): Catalog {
  return ro;
}

const rules = new Intl.PluralRules('ro');

/** Romanian plural; `#` in a form is replaced by the formatted number ("20 de fișiere"). */
export function plural(n: number, forms: { one: string; few: string; other: string }): string {
  const form = forms[rules.select(n) as 'one' | 'few' | 'other'] ?? forms.other;
  return form.replace('#', formatInt(n));
}
