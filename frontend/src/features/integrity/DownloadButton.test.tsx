import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { DownloadButton } from './DownloadButton';

const downloadAndVerify = vi.fn();
vi.mock('@/lib/integrity/verify', () => ({ downloadAndVerify: (...a: unknown[]) => downloadAndVerify(...a) }));

describe('DownloadButton', () => {
  it('shows "Fișier corupt detectat" with both hashes, the storage, the trace ID and the next step', async () => {
    downloadAndVerify.mockResolvedValueOnce({
      mode: 'client_verified', state: 'corrupt', badge: 'Fișier corupt detectat', expectedSha256: 'a'.repeat(64), actualSha256: 'b'.repeat(64),
      storage: 'ftp', traceId: 'trace-9', nextStep: 'notify_storage_team',
    });
    renderWithClient(<DownloadButton fileId="f-1" fileName="Avarie.pdf" size={10} storage="ftp" />);
    fireEvent.click(screen.getByRole('button', { name: 'Descarcă și verifică Avarie.pdf' }));
    expect(await screen.findByText('Fișier corupt detectat')).toBeInTheDocument();
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText('b'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText('trace-9')).toBeInTheDocument();
    expect(screen.getByText('Anunță echipa de storage')).toBeInTheDocument();
    expect(downloadAndVerify).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'f-1', size: 10, storage: 'ftp' }));
  });

  it('shows "Verificat" after a matching download', async () => {
    downloadAndVerify.mockResolvedValueOnce({
      mode: 'client_verified', state: 'verified', badge: 'Verificat', expectedSha256: 'c'.repeat(64), actualSha256: 'c'.repeat(64),
      storage: null, traceId: null, nextStep: null,
    });
    renderWithClient(<DownloadButton fileId="f-2" fileName="Citiri.csv" size={10} />);
    fireEvent.click(screen.getByRole('button', { name: 'Descarcă și verifică Citiri.csv' }));
    expect(await screen.findByText('Verificat')).toBeInTheDocument();
    expect(screen.getByText(/calculată în browser corespunde/)).toBeInTheDocument();
  });
});
