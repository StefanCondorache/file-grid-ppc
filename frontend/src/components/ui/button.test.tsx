import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('primary button is a pill on the action colour', () => {
    render(<Button>Încarcă</Button>);
    const btn = screen.getByRole('button', { name: 'Încarcă' });
    expect(btn.className).toContain('rounded-pill');
    expect(btn.className).toContain('bg-primary');
  });

  it('danger variant never uses the action colour', () => {
    render(<Button variant="danger">Oprește</Button>);
    expect(screen.getByRole('button').className).not.toContain('bg-primary');
  });
});
