import type { Metadata } from 'next';
import { FileDetailScreen } from '@/features/files/FileDetailScreen';

// A fixed title: never the file name or its metadata, which may hold personal data (SR-10, A11Y-9). So no
// generateMetadata here either.
export const metadata: Metadata = { title: 'Detaliu fișier · FileGrid' };

export default async function Page({ params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  return <FileDetailScreen fileId={fileId} />;
}
