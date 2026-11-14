import { describe, expect, it } from 'vitest';
import { findCedillas } from './check-diacritics.mjs';
import { findColorLiterals } from './check-colors.mjs';

describe('lint gates', () => {
  it('flags cedilla s/t but not comma-below', () => {
    expect(findCedillas('Rețele \u015F')).toEqual([7]);
    expect(findCedillas('Rețele ș')).toEqual([]);
  });

  it('flags raw colours outside tokens', () => {
    expect(findColorLiterals('a{color:#fff;background:rgb(0 0 0)}')).toEqual(['#fff', 'rgb(0 0 0)']);
    expect(findColorLiterals('a{color:var(--fg-ink)}')).toEqual([]);
  });
});
