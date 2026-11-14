import { Download } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { apiUrl } from '@/lib/api/base';
import { useT } from '@/lib/i18n';

/**
 * The download action of the file detail. For now a plain link straight to the API (the bytes never pass through
 * Next.js); the backend recomputes the SHA-256 while it streams and cuts the connection on a mismatch. Kept in its own
 * component so the streaming verifier (6c.8, `features/integrity/DownloadButton`) can replace it in one place.
 */
export function FileDownloadSlot({ fileId }: { fileId: string }) {
  const t = useT();
  return (
    <a href={apiUrl(`/files/${encodeURIComponent(fileId)}/content`)} download className={buttonVariants({ variant: 'primary', size: 'md' })}>
      <Download aria-hidden="true" />
      {t.files.detail.download}
    </a>
  );
}
