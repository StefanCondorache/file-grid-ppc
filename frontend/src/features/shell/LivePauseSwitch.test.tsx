import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAnnouncements, resetAnnouncer } from '@/lib/a11y/announcer';
import { useAppStore } from '@/stores/app-store';
import { LivePauseSwitch } from './LivePauseSwitch';

beforeEach(() => {
  resetAnnouncer();
  useAppStore.setState({ livePaused: false });
});

describe('LivePauseSwitch', () => {
  it('toggles livePaused and announces the new state', async () => {
    const user = userEvent.setup();
    render(<LivePauseSwitch />);
    const sw = screen.getByRole('switch', { name: /Actualizări live/ });
    expect(sw).toHaveAttribute('aria-checked', 'true');

    await user.click(sw);
    expect(useAppStore.getState().livePaused).toBe(true);
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(getAnnouncements().polite.text).toMatch(/în pauză/);

    await user.click(sw);
    expect(useAppStore.getState().livePaused).toBe(false);
    expect(getAnnouncements().polite.text).toMatch(/pornite/);
  });
});
