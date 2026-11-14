import { describe, expectTypeOf, it } from 'vitest';
import type { Category, DemoStatus, LoginOptions, Me, Role } from './types';

describe('generated contract types', () => {
  it('exposes the proposal enums and shapes', () => {
    expectTypeOf<Category>().toEqualTypeOf<'meter' | 'fault' | 'connection' | 'drone'>();
    expectTypeOf<Me['activeRole']>().toEqualTypeOf<Role>();
    expectTypeOf<DemoStatus['storageControl']>().toEqualTypeOf<boolean>();
    expectTypeOf<LoginOptions>().toEqualTypeOf<{ passwordless: boolean }>();
  });
});
