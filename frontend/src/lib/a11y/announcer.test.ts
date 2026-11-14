import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce, getAnnouncements, resetAnnouncer } from './announcer';

describe('announcer', () => {
  beforeEach(() => { vi.useFakeTimers(); resetAnnouncer(); });
  afterEach(() => vi.useRealTimers());

  it('dedupes announcements within 2 s', () => {
    announce('Avarie nouă');
    vi.advanceTimersByTime(1000);
    announce('Avarie nouă');
    expect(getAnnouncements().polite.count).toBe(1);
    vi.advanceTimersByTime(1500);
    announce('Avarie nouă');
    expect(getAnnouncements().polite.count).toBe(2);
  });

  it('routes assertive messages to their own region', () => {
    announce('Fișier corupt detectat', 'assertive');
    expect(getAnnouncements().assertive.text).toBe('Fișier corupt detectat');
    expect(getAnnouncements().polite.text).toBe('');
  });
});
