import type { Metadata } from 'next';
import { FilesScreen } from '@/features/files/FilesScreen';

// The title never carries a filter value: a search may hold anything the user typed (SR-10).
export const metadata: Metadata = { title: 'Fișiere · FileGrid' };

export default function Page() {
  return <FilesScreen />;
}
