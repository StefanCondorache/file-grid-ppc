import { DownloadButton } from '@/features/integrity/DownloadButton';

type Props = {
  fileId: string;
  fileName: string;
  size: number;
  storage?: string | null;
  expectedSha256?: string | null;
};

/**
 * The download action of the file detail: the streaming verifier from 6c.8 (`features/integrity/DownloadButton`).
 * It downloads straight from the API (bytes never pass through Next.js), recomputes the SHA-256 and shows
 * "Verificat" or "Fișier corupt detectat" with both hashes; large files are verified by the server.
 */
export function FileDownloadSlot({ fileId, fileName, size, storage, expectedSha256 }: Props) {
  return (
    <DownloadButton fileId={fileId} fileName={fileName} size={size} storage={storage} expectedSha256={expectedSha256} />
  );
}
