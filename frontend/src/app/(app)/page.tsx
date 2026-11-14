import type { Metadata } from 'next';
import { GuaranteesBoard } from '@/features/guarantees/GuaranteesBoard';

export const metadata: Metadata = { title: 'Garanții de business · FileGrid' };

/** Home (SC-02): the four business guarantees, live. */
export default function GuaranteesPage() {
  return <GuaranteesBoard />;
}
