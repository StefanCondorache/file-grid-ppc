import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dropzone } from './Dropzone';

const video = () => new File(['drone bytes'], 'Inspectie_LEA_110kV.mp4', { type: 'video/mp4', lastModified: 1 });

describe('Dropzone', () => {
  it('dropzone has a real "Alege fișiere" button', async () => {
    const onFiles = vi.fn();
    const { container } = render(<Dropzone hint="MP4, MOV · maximum 4 GB" onFiles={onFiles} />);

    // Nothing is drag-only (WCAG 2.5.7, A11Y-13): a real, visible button opens the native file picker.
    const button = screen.getByRole('button', { name: 'Alege fișiere' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toBeVisible();
    expect(screen.getByText(/MP4, MOV · maximum 4 GB/)).toBeInTheDocument();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).toHaveAttribute('multiple');
    const opened = vi.spyOn(input, 'click');
    await userEvent.setup().click(button);
    expect(opened).toHaveBeenCalledTimes(1);

    // The picker gives no file-system handle; the upload re-selects after a reload.
    const file = video();
    await userEvent.setup().upload(input, file);
    expect(onFiles).toHaveBeenCalledWith([{ file, handle: null }]);
    // The same file can be chosen again right after (the input is cleared).
    expect(input.value).toBe('');
  });

  it('a dropped file keeps its file handle, captured during the drop event', async () => {
    const onFiles = vi.fn();
    render(<Dropzone hint="MP4" onFiles={onFiles} />);
    const zone = screen.getByText('Trage fișierele aici').closest<HTMLElement>('[data-dropzone]')!;
    const file = video();
    const handle = { kind: 'file', name: file.name, getFile: async () => file };
    const item = { kind: 'file', type: file.type, getAsFile: () => file, getAsFileSystemHandle: vi.fn(async () => handle) };

    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'], items: [item] } });
    expect(zone).toHaveAttribute('data-state', 'over');

    const drop = createEvent.drop(zone, { dataTransfer: { types: ['Files'], items: [item], files: [file] } });
    fireEvent(zone, drop);
    // Chromium empties the item list once the handler returns: the handle is asked for synchronously.
    expect(item.getAsFileSystemHandle).toHaveBeenCalledTimes(1);
    expect(drop.defaultPrevented).toBe(true);
    expect(zone).toHaveAttribute('data-state', 'idle');
    await waitFor(() => expect(onFiles).toHaveBeenCalledWith([{ file, handle }]));
  });

  it('shows why files were refused, next to an inert file name', () => {
    render(<Dropzone hint="MP4" onFiles={() => {}} rejected={[{ name: 'gol\u202Etxt.mp4', reasons: ['Fișierul este gol.'] }]} />);
    const item = screen.getByText('Fișierul este gol.').closest('li')!;
    expect(item).toHaveTextContent('goltxt.mp4: Fișierul este gol.');
    expect(screen.getByText('Trage fișierele aici').closest('[data-dropzone]')).toHaveAttribute('data-state', 'rejected');
  });
});
