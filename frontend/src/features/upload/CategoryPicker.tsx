import { FileText, Video, Zap, type LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { useT } from '@/lib/i18n';
import type { UploadCategoryId } from '@/lib/upload/types';
import { policyLine } from './PolicySummary';
import type { UploadPolicies } from './queries';

const ICON: Record<UploadCategoryId, LucideIcon> = { drone_videos: Video, fault_records: Zap, connection_documents: FileText };

/**
 * The category, as radio tiles (components.md "Category picker"): native radios, so arrow keys and screen readers
 * work as usual. Only the categories the active role may upload are offered (FE-01); each tile carries its policy.
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  policies,
}: {
  categories: readonly UploadCategoryId[];
  value: UploadCategoryId;
  onChange(category: UploadCategoryId): void;
  policies: UploadPolicies;
}) {
  const t = useT().upload;
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-3 text-[13px] font-bold tracking-wide text-ink-2 uppercase">{t.screen.category}</legend>
      <div className="grid gap-4 md:grid-cols-3">
        {categories.map((category) => {
          const Icon = ICON[category];
          const policy = policies[category];
          return (
            <label
              key={category}
              className="glass-card tilt-soft flex cursor-pointer items-start gap-3.5 rounded-card p-4 has-[:checked]:border-2 has-[:checked]:border-primary has-[:checked]:bg-accent has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
            >
              <input
                type="radio"
                name={name}
                value={category}
                checked={value === category}
                onChange={() => onChange(category)}
                aria-labelledby={`${name}-${category}`}
                aria-describedby={`${name}-${category}-hint`}
                className="sr-only"
              />
              <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-panel bg-surface-2 text-ink">
                <Icon className="size-5" strokeWidth={1.75} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span id={`${name}-${category}`} className="text-base font-bold">
                  {t.categories[category].title}
                </span>
                <span id={`${name}-${category}-hint`} className="flex flex-col gap-0.5 text-sm text-ink-2">
                  <span>{t.categories[category].hint}</span>
                  {policy && <span>{policyLine(policy)}</span>}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
