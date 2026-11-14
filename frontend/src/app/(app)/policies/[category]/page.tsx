import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PolicyScreen } from '@/features/policies/PolicyScreen';
import { toCategory } from '@/features/policies/types';

export const metadata: Metadata = { title: 'Politică · FileGrid' };

export default async function Page({ params }: { params: Promise<{ category: string }> }) {
  const category = toCategory((await params).category);
  if (!category) notFound();
  return <PolicyScreen category={category} />;
}
