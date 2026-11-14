import { describe, expect, it } from 'vitest';
import { plural } from './index';

const forms = { one: '1 fișier', few: '# fișiere', other: '# de fișiere' };

describe('plural', () => {
  it('uses the Romanian "de" plural', () => {
    expect(plural(1, forms)).toBe('1 fișier');
    expect(plural(3, forms)).toBe('3 fișiere');
    expect(plural(20, forms)).toBe('20 de fișiere');
    expect(plural(1284, forms)).toBe('1\u00A0284 de fișiere');
  });
});
