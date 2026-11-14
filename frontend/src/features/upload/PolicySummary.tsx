import { useId } from 'react';
import { Card } from '@/components/ui/card';
import { formatInt } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n';
import { ro } from '@/lib/i18n/ro';
import { formatLimit } from '@/lib/upload/plan';
import type { UploadCategoryId } from '@/lib/upload/types';
import type { UploadPolicyView } from './queries';

const MiB = 1024 * 1024;
const NBSP = '\u00A0';

/** Part size the way the policy states it: "8 MiB", "1,5 MiB". */
export function formatPartSize(bytes: number): string {
  const mib = bytes / MiB;
  const text = Number.isInteger(mib) ? formatInt(mib) : new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 1 }).format(mib);
  return `${text}${NBSP}MiB`;
}

const TYPE_LABEL: Record<string, string> = {
  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'application/json': 'JSON',
};

/** "MP4, MOV" from the policy's MIME types; "orice tip" when the policy allows any. */
export function formatTypes(types: readonly string[]): string {
  if (types.length === 0) return ro.upload.screen.anyType;
  return types.map((type) => TYPE_LABEL[type] ?? (type.split('/')[1] ?? type).toUpperCase()).join(', ');
}

/** The tile line of a category: "S3 · 8 MiB · criptat: nu". */
export function policyLine(p: UploadPolicyView): string {
  return ro.upload.policy.tile(ro.upload.storages[p.primaryStorage], formatPartSize(p.chunkSize), p.encryptionAtRest);
}

/**
 * "Unde ajunge fișierul" (FE-02, F2, F3): the live policy of the chosen category. The limits come from the policy,
 * never from code, and the summary states that an upload keeps the policy it started with (beat 7).
 */
export function PolicySummary({ category, policy, loading }: { category: UploadCategoryId; policy: UploadPolicyView | undefined; loading: boolean }) {
  const t = useT().upload;
  const titleId = useId();
  const storage = (s: UploadPolicyView['primaryStorage']) => t.storages[s];
  return (
    <Card aria-labelledby={titleId} className="flex flex-col gap-4">
      <h2 id={titleId} className="text-lg font-bold">
        {t.policy.title}
      </h2>
      {policy ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-2">{t.policy.storage}</dt>
          <dd className="font-semibold">{t.policy.storageValue(storage(policy.primaryStorage), policy.fallbackStorage ? storage(policy.fallbackStorage) : null)}</dd>
          <dt className="text-ink-2">{t.policy.policy}</dt>
          <dd className="font-semibold">{t.policy.policyValue(t.categories[category].short, policy.version)}</dd>
          <dt className="text-ink-2">{t.policy.parts}</dt>
          <dd className="font-semibold">{t.policy.partsValue(formatPartSize(policy.chunkSize), policy.maxParallel)}</dd>
          <dt className="text-ink-2">{t.policy.encryption}</dt>
          <dd className="font-semibold">{policy.encryptionAtRest ? t.policy.encrypted(policy.encryptionAlgorithm) : t.policy.notEncrypted}</dd>
          <dt className="text-ink-2">{t.policy.maxSize}</dt>
          <dd className="font-semibold">{formatLimit(policy.maxFileSize)}</dd>
          <dt className="text-ink-2">{t.policy.types}</dt>
          <dd className="font-semibold">{formatTypes(policy.allowedTypes)}</dd>
        </dl>
      ) : (
        <p className="text-sm text-ink-2" aria-busy={loading || undefined}>
          {loading ? t.policy.loading : t.policy.unavailable}
        </p>
      )}
      <p className="text-sm text-ink-2">{t.policy.frozen}</p>
    </Card>
  );
}
