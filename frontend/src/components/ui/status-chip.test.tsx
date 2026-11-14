import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusChip } from './status-chip';

describe('StatusChip', () => {
  it('renders the status word, not only colour', () => {
    const { container } = render(<StatusChip tone="warn" label="În pericol" />);
    const chip = screen.getByText('În pericol').closest('span[data-tone]');
    expect(chip).toHaveAttribute('data-tone', 'warn');
    expect(chip?.className).toContain('rounded-chip');
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
