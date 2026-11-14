import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadEngine } from '@/lib/upload/engine';
import { bitsetNew, bitsetSet } from '@/lib/upload/repo';
import { useUploadStore, type UploadItemView } from '@/lib/upload/store';
import { UploadQueue } from './UploadQueue';

const MiB = 1024 * 1024;
const NBSP = '\u00A0';
/** Text matching without whitespace normalisation, so the NBSP before units is checked too. */
const exact = { normalizer: (s: string) => s };

function item(patch: Partial<UploadItemView>): UploadItemView {
  return {
    id: 'u1', displayName: 'Inspectie_LEA_110kV.mp4', category: 'drone_videos', size: 40 * MiB, bytesConfirmed: 0, bytesInFlight: 0,
    hashedBytes: 0, speedBps: null, etaS: null, state: 'queued', offline: false, startedAsRole: 'teren', ownerUserId: 'u-teren',
    partCount: null, confirmed: new Uint8Array(0), inFlightParts: [], retryingParts: [], reopenable: false, ...patch,
  };
}

const show = (...items: UploadItemView[]) => act(() => useUploadStore.setState({ items: Object.fromEntries(items.map((i) => [i.id, i])) }));

beforeEach(() => useUploadStore.setState({ items: {} }));
afterEach(() => vi.restoreAllMocks());

describe('UploadQueue', () => {
  it('says so when nothing is queued', () => {
    render(<UploadQueue />);
    expect(screen.getByText(/Niciun fișier în coadă/)).toBeInTheDocument();
  });

  it('shows each upload with its state, progress, role, policy and named actions', async () => {
    const pause = vi.spyOn(uploadEngine, 'pause').mockImplementation(() => {});
    render(<UploadQueue />);
    show(
      item({
        state: 'connection_lost', partCount: 5, confirmed: [1, 2].reduce((b, n) => bitsetSet(b, n), bitsetNew(5)), bytesConfirmed: 16 * MiB,
        inFlightParts: [3], retryingParts: [4], retryAt: Date.now() + 6_000, retryInS: 6, clientSha256: '9f2c51d0'.padEnd(56, '0') + 'a83be41a', policyVersion: 3,
      }),
      item({ id: 'u2', displayName: 'Avarie_PT_Medgidia.pdf', category: 'fault_records', size: 5 * MiB, state: 'verified', partCount: 1, confirmed: bitsetSet(bitsetNew(1), 1), bytesConfirmed: 5 * MiB, verdict: 'match', fileId: 'f-1', clientSha256: 'a'.repeat(64), serverSha256: 'a'.repeat(64), availableAfterMs: 1200, storage: 'ftp', usedFallback: true }),
    );

    expect(screen.getByText('2 fișiere · 1 în curs')).toBeInTheDocument();
    const [lost, done] = screen.getAllByRole('listitem').filter((li) => li.closest('ul')?.dataset.queue !== undefined);
    expect(within(lost).getByText(/^Conexiune pierdută/)).toBeInTheDocument();
    expect(within(lost).getByRole('progressbar', { name: 'Inspectie_LEA_110kV.mp4' })).toHaveAttribute(
      'aria-valuetext',
      `40${NBSP}%, 16${NBSP}MB din 40${NBSP}MB, conexiune pierdută, reîncercare automată în 6 secunde`,
    );
    expect(within(lost).getByText(`16${NBSP}MB din 40${NBSP}MB · 2 din 5 bucăți confirmate`, exact)).toBeInTheDocument();
    expect(within(lost).getByText('Pornit ca')).toHaveTextContent('Pornit ca Echipă de teren');
    expect(within(lost).getByText('Politica v3 (la pornire)')).toBeInTheDocument();
    expect(within(lost).getByText('9f2c51d0…a83be41a')).toBeInTheDocument();

    // Button names keep the visible label first, then the file (A11Y-12, WCAG 2.5.3).
    await userEvent.setup().click(within(lost).getByRole('button', { name: 'Pauză Inspectie_LEA_110kV.mp4' }));
    expect(pause).toHaveBeenCalledWith('u1');
    expect(within(lost).getByRole('button', { name: 'Anulează Inspectie_LEA_110kV.mp4' })).toBeInTheDocument();

    expect(within(done).getByText('Verificat')).toBeInTheDocument();
    expect(within(done).getByText(`Disponibil pentru dispecerat în 1,2${NBSP}s`, exact)).toBeInTheDocument();
    expect(within(done).getByText('Scris pe rezervă: FTP')).toBeInTheDocument();
    expect(within(done).getByRole('link', { name: 'Deschide fișierul' })).toHaveAttribute('href', '/files/f-1');
  });

  it('after a reload, one click reopens a stored file or the user picks it again', async () => {
    const grant = vi.spyOn(uploadEngine, 'grantFileAccess').mockResolvedValue();
    const reattach = vi.spyOn(uploadEngine, 'reattach').mockResolvedValue();
    const { container } = render(<UploadQueue />);
    show(item({ state: 'needs_file', reopenable: true }), item({ id: 'u2', displayName: 'Inspectie_2.mp4', state: 'needs_file' }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Continuă încărcarea Inspectie_LEA_110kV.mp4' }));
    expect(grant).toHaveBeenCalledWith('u1');

    const again = screen.getByRole('button', { name: 'Alege din nou fișierul Inspectie_2.mp4' });
    const input = container.querySelector<HTMLInputElement>(`input[type="file"][data-reattach="u2"]`)!;
    const opened = vi.spyOn(input, 'click');
    await user.click(again);
    expect(opened).toHaveBeenCalledTimes(1);
    const file = new File(['x'], 'Inspectie_2.mp4', { type: 'video/mp4' });
    await user.upload(input, file);
    expect(reattach).toHaveBeenCalledWith('u2', file);
  });

  it('asks before cancelling an upload in progress', async () => {
    const cancel = vi.spyOn(uploadEngine, 'cancel').mockResolvedValue();
    render(<UploadQueue />);
    show(item({ state: 'uploading', partCount: 5, confirmed: bitsetSet(bitsetNew(5), 1), bytesConfirmed: 8 * MiB }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Anulează Inspectie_LEA_110kV.mp4' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Anulezi încărcarea/)).toHaveTextContent('Anulezi încărcarea Inspectie_LEA_110kV.mp4?');
    // Focus starts on the safe choice.
    expect(within(dialog).getByRole('button', { name: 'Nu, continuă' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Da, anulează' }));
    expect(cancel).toHaveBeenCalledWith('u1');
  });
});
