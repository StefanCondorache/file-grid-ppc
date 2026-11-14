import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartFigure } from './ChartFigure';

describe('ChartFigure', () => {
  it('chart has a table alternative from the same data', () => {
    render(
      <ChartFigure
        title="Timp de răspuns p95"
        interpretation="Avariile cresc; restul rămân sub 1 s."
        columns={[{ key: 'cat', label: 'Categorie' }, { key: 'p95', label: 'p95', align: 'right' }]}
        rows={[{ cat: 'Avarii', p95: '3,4 s' }, { cat: 'Contoare', p95: '0,5 s' }]}
      >
        <svg />
      </ChartFigure>,
    );
    expect(screen.getByRole('figure', { name: 'Timp de răspuns p95' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Timp de răspuns p95' })).toBeInTheDocument();
    expect(screen.getByText('Vezi ca tabel')).toBeInTheDocument();
    const table = screen.getByRole('table', { hidden: true });
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(3);
    expect(screen.getByText('Avariile cresc; restul rămân sub 1 s.')).toBeInTheDocument();
  });
});
