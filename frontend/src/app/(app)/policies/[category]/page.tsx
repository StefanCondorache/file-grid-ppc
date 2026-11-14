import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PolicyForm } from '@/features/policies/PolicyForm';
import { POLICY_CATEGORIES, type PolicyCategory } from '@/features/policies/schema';
import { ro } from '@/lib/i18n/ro';

export const metadata: Metadata = { title: 'Politică · FileGrid' };

export default async function Page({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  if (!POLICY_CATEGORIES.includes(category as PolicyCategory)) notFound();
  const c = category as PolicyCategory;
  return (
    <div className="flex flex-col gap-4">
      <Link href="/policies" className="text-(--fg-link) underline">{ro.policies.back}</Link>
      <h1 className="text-[28px] font-bold">{ro.policies.categories[c]}</h1>
      <PolicyForm category={c} />
    </div>
  );
}
