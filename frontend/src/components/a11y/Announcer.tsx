'use client';

import { useSyncExternalStore } from 'react';
import { getAnnouncements, subscribeAnnouncements } from '@/lib/a11y/announcer';

/** Two visually hidden live regions shared by the whole app (A11Y-11). */
export function Announcer() {
  const s = useSyncExternalStore(subscribeAnnouncements, getAnnouncements, getAnnouncements);
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        <span key={s.polite.count}>{s.polite.text}</span>
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        <span key={s.assertive.count}>{s.assertive.text}</span>
      </div>
    </>
  );
}
