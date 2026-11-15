'use client';

import { useState } from 'react';
import { ErrorState } from '@/components/ErrorState';
import { Button } from '@/components/ui/button';
import { useMe } from '@/features/auth/queries';
import { ApiError } from '@/lib/api/errors';
import { can } from '@/lib/auth/capabilities';
import { useT } from '@/lib/i18n';
import type { PolicyView } from '@/lib/upload/contract';
import { ConflictNotice } from './ConflictNotice';
import { DiffDialog } from './DiffDialog';
import { diffPolicy, STORAGE_LABEL } from './diff';
import { usePolicies, useSavePolicy } from './queries';
import { draftFromPolicy, STORAGE_IDS, toUpdate, validateDraft, type PolicyCategory, type PolicyDraft } from './schema';
import { VersionHistory } from './VersionHistory';

const FIELD = 'h-10 rounded-panel border border-(--fg-line-input) bg-surface px-3 text-ink disabled:opacity-60';

export function PolicyForm({ category }: { category: PolicyCategory }) {
  const t = useT().policies;
  const me = useMe().data;
  const list = usePolicies();
  const policy = list.data?.find((p) => p.category === category);
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (!policy) return <p className="text-ink-2">{list.isLoading ? '…' : t.unknownCategory}</p>;
  return <Editor category={category} policy={policy} editable={can(me, 'edit_policies')} />;
}

function Editor({ category, policy, editable }: { category: PolicyCategory; policy: PolicyView; editable: boolean }) {
  const t = useT().policies;
  const list = usePolicies();
  const save = useSavePolicy(category);
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFromPolicy(policy));
  const [confirming, setConfirming] = useState(false);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState<PolicyView | null>(null);
  const [serverError, setServerError] = useState<unknown>(null);

  const errors = validateDraft(category, draft);
  const rows = diffPolicy(policy, toUpdate(policy, draft));
  const set = <K extends keyof PolicyDraft>(k: K, v: PolicyDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const num = (v: string) => (v === '' ? NaN : Number(v));

  async function confirm() {
    setServerError(null);
    try {
      const next = await save.mutateAsync(toUpdate(policy, draft));
      setConfirming(false);
      setSavedVersion(next.version);
      setDraft(draftFromPolicy(next));
    } catch (e) {
      setConfirming(false);
      if (e instanceof ApiError && e.code === 'POLICY_VERSION_CONFLICT') {
        const fresh = (await list.refetch()).data?.find((p) => p.category === category);
        if (fresh) {
          setConflict(fresh);
          return;
        }
      }
      setServerError(e instanceof ApiError && e.code === 'ENCRYPTION_LOCKED' ? new ApiError(422, 'ENCRYPTION_LOCKED', t.encryptionLockedError) : e);
    }
  }

  const fieldError = (k: string) => errors[k] && <p className="text-sm text-crit-ink" role="alert">{errors[k]}</p>;
  const encLocked = policy.encryptionLocked;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-ink-2">{t.version(policy.version)} · {policy.updatedBy.displayName}</p>
      {!editable && <p className="rounded-panel border border-border bg-surface-2 p-3">{t.readOnly}</p>}
      {savedVersion !== null && <p role="status" className="rounded-panel bg-ok-tint p-3 font-semibold text-ok-ink">{t.saved(savedVersion)}</p>}
      {conflict && (
        <ConflictNotice
          current={conflict}
          rows={diffPolicy(conflict, toUpdate(conflict, draft))}
          onReload={() => {
            setConflict(null);
            setDraft(draftFromPolicy(conflict));
          }}
        />
      )}
      {serverError !== null && <ErrorState error={serverError} />}
      <form
        className="grid max-w-xl gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (editable && rows.length > 0 && Object.keys(errors).length === 0) setConfirming(true);
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="font-semibold">{t.primary}</span>
          <select className={FIELD} disabled={!editable} value={draft.primaryStorage} onChange={(e) => set('primaryStorage', e.target.value as PolicyDraft['primaryStorage'])}>
            {STORAGE_IDS.map((s) => <option key={s} value={s}>{STORAGE_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-semibold">{t.fallback}</span>
          <select className={FIELD} disabled={!editable} value={draft.fallbackStorage ?? ''} onChange={(e) => set('fallbackStorage', (e.target.value || null) as PolicyDraft['fallbackStorage'])}>
            <option value="">{t.noFallback}</option>
            {STORAGE_IDS.map((s) => <option key={s} value={s}>{STORAGE_LABEL[s]}</option>)}
          </select>
          {fieldError('fallbackStorage')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-5" disabled={!editable || encLocked} checked={draft.encryptionAtRest} onChange={(e) => set('encryptionAtRest', e.target.checked)} />
          <span className="font-semibold">{t.encryption}</span>
        </label>
        {encLocked && <p className="-mt-2 text-sm text-ink-2">{t.encryptionLocked}</p>}
        <label className="flex flex-col gap-1">
          <span className="font-semibold">{t.chunk}</span>
          <input type="number" className={FIELD} disabled={!editable} value={Number.isNaN(draft.chunkMiB) ? '' : draft.chunkMiB} onChange={(e) => set('chunkMiB', num(e.target.value))} />
          {fieldError('chunkMiB')}
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-semibold">{t.parallel}</span>
          <input type="number" className={FIELD} disabled={!editable} value={Number.isNaN(draft.maxParallel) ? '' : draft.maxParallel} onChange={(e) => set('maxParallel', num(e.target.value))} />
          {fieldError('maxParallel')}
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-semibold">{t.concurrency}</span>
          <input type="number" className={FIELD} disabled={!editable} value={Number.isNaN(draft.maxConcurrency) ? '' : draft.maxConcurrency} onChange={(e) => set('maxConcurrency', num(e.target.value))} />
          {fieldError('maxConcurrency')}
        </label>
        {editable && (
          <div>
            <Button type="submit" disabled={rows.length === 0 || Object.keys(errors).length > 0}>{t.review}</Button>
          </div>
        )}
      </form>
      <DiffDialog open={confirming} rows={rows} saving={save.isPending} onConfirm={() => void confirm()} onCancel={() => setConfirming(false)} />
      <VersionHistory category={category} />
    </div>
  );
}
