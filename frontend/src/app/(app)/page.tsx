import type { Metadata } from 'next';
import { AlertsList } from '@/features/guarantees/AlertsList';
import { GuaranteesBoard } from '@/features/guarantees/GuaranteesBoard';

export const metadata: Metadata = { title: 'Garanții de business · FileGrid' };

/** Home (SC-02): the four business guarantees and their alerts, live. */
export default function GuaranteesPage() {
  return (
    <>
      <GuaranteesBoard />
      <AlertsList />
    </>
  );
}
