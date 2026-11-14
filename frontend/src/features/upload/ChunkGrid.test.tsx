import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bitsetNew, bitsetSet } from '@/lib/upload/repo';
import { ChunkGrid } from './ChunkGrid';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const NBSP = '\u00A0';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const bits = (parts: number, confirmed: number[]) => confirmed.reduce((b, n) => bitsetSet(b, n), bitsetNew(parts));

describe('ChunkGrid', () => {
  it('chunk grid exposes Romanian progress text', () => {
    // The beat-2 row of the mockup: 89 of 154 parts confirmed, 712 MB of a 1,23 GB video.
    render(<ChunkGrid parts={154} confirmed={bits(154, range(1, 89))} inFlight={[90, 91, 93]} failed={[92]} bytes={712 * MiB} size={Math.round(1.23 * GiB)} />);

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuetext', `58${NBSP}%, 712${NBSP}MB din 1,23${NBSP}GB`);
    expect(bar).toHaveAttribute('aria-valuenow', '58');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('draws at most 256 cells, each one standing for ⌈parts/256⌉ parts', () => {
    const { container, rerender } = render(
      <ChunkGrid parts={154} confirmed={bits(154, range(1, 89))} inFlight={[90, 91, 93]} failed={[92]} bytes={0} size={1} />,
    );
    const cells = () => [...container.querySelectorAll<HTMLElement>('[data-cell]')].map((c) => c.dataset.cell);
    expect(cells()).toHaveLength(154);
    expect(cells().slice(87, 94)).toEqual(['done', 'done', 'flight', 'flight', 'failed', 'flight', 'pending']);

    // 10 000 parts (a 4 GB file in 5 MiB parts would be 820): 40 parts per cell, 250 cells.
    rerender(<ChunkGrid parts={10_000} confirmed={bits(10_000, range(1, 79))} inFlight={[80]} failed={[85]} bytes={0} size={1} />);
    expect(cells()).toHaveLength(250);
    expect(cells().slice(0, 4)).toEqual(['done', 'flight', 'failed', 'pending']);
    // The grid is decoration: the progress bar carries the meaning (A11Y-12).
    expect(container.querySelector('[data-cell]')?.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
