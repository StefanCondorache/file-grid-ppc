'use client';

import { useEffect, useRef } from 'react';
import { announce } from '@/lib/a11y/announcer';
import { useT } from '@/lib/i18n';
import type { CategoryId, GuaranteeState, GuaranteeStatus } from '@/lib/monitoring/contract';

/**
 * Flapping states are announced only once they hold for this long (accessibility.md §4). The cards and the alert
 * banner share it: both word a change identically, fire together, and the announcer's 2 s dedupe says it once.
 */
export const FLAP_MS = 3_000;

/**
 * Speaks every guarantee's state change through the shared announcer, as the cards do: "Garanția Avarii: În pericol"
 * polite, `violated` assertive, a return to OK polite. Silent for the first data (no load-time alerts, A11Y-16).
 */
export function useGuaranteeAnnouncements(guarantees: readonly GuaranteeStatus[] | undefined): void {
  const t = useT().monitoring;
  const spoken = useRef(new Map<CategoryId, GuaranteeState>());
  const pending = useRef(new Map<CategoryId, { state: GuaranteeState; timer: ReturnType<typeof setTimeout> }>());

  useEffect(() => {
    if (!guarantees) return;
    for (const g of guarantees) {
      const said = spoken.current.get(g.category);
      if (said === undefined) {
        spoken.current.set(g.category, g.state);
        continue;
      }
      const waiting = pending.current.get(g.category);
      if (waiting?.state === g.state) continue;
      if (waiting) {
        clearTimeout(waiting.timer);
        pending.current.delete(g.category);
      }
      if (g.state === said) continue;
      const { category, state } = g;
      const timer = setTimeout(() => {
        pending.current.delete(category);
        spoken.current.set(category, state);
        announce(t.stateChanged(t.categories[category], t.states[state]), state === 'violated' ? 'assertive' : 'polite');
      }, FLAP_MS);
      pending.current.set(category, { state, timer });
    }
  }, [guarantees, t]);

  useEffect(() => {
    const timers = pending.current;
    return () => {
      for (const p of timers.values()) clearTimeout(p.timer);
      timers.clear();
    };
  }, []);
}
