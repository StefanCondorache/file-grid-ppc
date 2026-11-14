import { describe, expect, it } from 'vitest';
import { formatBytes, formatDateTime, formatDuration, formatInt, formatPercent } from './format';

describe('Romanian formatters', () => {
  it('formats numbers the Romanian way', () => {
    expect(formatBytes(5_347_737)).toBe('5,1\u00A0MB');
    expect(formatBytes(1_320_702_444)).toBe('1,23\u00A0GB');
    expect(formatInt(1_284_532)).toBe('1\u00A0284\u00A0532');
    expect(formatPercent(0.987)).toBe('98,7\u00A0%');
    expect(formatDuration(1200)).toBe('1,2\u00A0s');
    expect(formatDuration(14)).toBe('14\u00A0ms');
  });

  it('formats date-times in Bucharest time', () => {
    expect(formatDateTime('2026-11-14T13:41:00Z')).toBe('14.11.2026, 15:41');
  });
});
