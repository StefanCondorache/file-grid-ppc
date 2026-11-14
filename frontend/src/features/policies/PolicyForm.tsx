'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { useForm, type Path } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/errors';
import { useT } from '@/lib/i18n';
import { conflictPolicy } from './api';
import { ConflictNotice } from './ConflictNotice';
import { diffPolicy, formatValue } from './diff';
import { DiffDialog } from './DiffDialog';
import { useSavePolicy } from './queries';
import { policySchema, toFormValues, toUpdate, type PolicyFormValues } from './schema';
import { STORAGES, type PolicyDoc, type PolicyUpdate } from './types';

const control = 'h-11 rounded-control border-[1.5px] border-input bg-surface px-3 text-[15px] font-normal text-ink';
const SERVER_FIELD: Record<string, Path<PolicyFormValues>> = {
  primaryStorage: 'primaryStorage', fallbackStorage: 'fallbackStorage', encryptionAtRest: 'encryptionAtRest', chunkSize: 'chunkSizeMiB', maxParallel: 'maxParallel',
};

function ReadOnly({ policy }: { policy: PolicyDoc }) {
  const t = useT().policies;
  const fields = ['primaryStorage', 'fallbackStorage', 'encryptionAtRest', 'chunkSize', 'maxParallel', 'maxFileSize', 'allowedTypes', 'retentionDays'] as const;
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-panel bg-info-tint px-4 py-3 text-info-ink">{t.readOnly}</p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f} className="flex flex-col">
            <dt className="text-sm text-ink-2">{t.field[f]}</dt>
            <dd className="font-semibold">{formatValue(f, policy[f])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Edit form: review → diff dialog → PUT with baseVersion; 409 shows the server's version and re-applies on top. */
export function PolicyForm({ policy, canEdit }: { policy: PolicyDoc; canEdit: boolean }) {
  const t = useT().policies;
  const save = useSavePolicy(policy.category);
  const [base, setBase] = useState(policy);
  const [pending, setPending] = useState<PolicyUpdate | null>(null);
  const [conflict, setConflict] = useState<PolicyDoc | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [noChanges, setNoChanges] = useState(false);
  const resolver = useMemo(() => zodResolver(policySchema(policy.category)), [policy.category]);
  const { register, handleSubmit, reset, getValues, setError, formState } = useForm<PolicyFormValues>({ resolver, defaultValues: toFormValues(policy) });
  const { errors } = formState;

  // The form stays on the version it was opened with; a newer server version surfaces as a 409 on save.
  if (!canEdit) return <ReadOnly policy={policy} />;

  const review = handleSubmit((values) => {
    setSaved(null);
    setFailure(null);
    const update = toUpdate(base, values);
    const changed = diffPolicy(base, update).length > 0;
    setNoChanges(!changed);
    if (changed) setPending(update);
  });

  const confirm = () => {
    if (!pending) return;
    save.mutate(pending, {
      onSuccess: (next) => {
        setPending(null);
        setBase(next);
        reset(toFormValues(next));
        setSaved(next.version);
      },
      onError: (error) => {
        setPending(null);
        const current = conflictPolicy(error);
        if (current) return setConflict(current);
        const code = error instanceof ApiError ? error.code : '';
        setFailure((t.error as Record<string, string>)[code] ?? t.error.generic);
        if (error instanceof ApiError) {
          for (const fe of error.fieldErrors) {
            const field = SERVER_FIELD[fe.field];
            if (field) setError(field, { message: fe.message });
          }
        }
      },
    });
  };

  // Re-apply: only the fields this admin changed, on top of the server's version.
  const applyOnTop = () => {
    if (!conflict) return;
    const before = toFormValues(base);
    const mine = getValues();
    const merged = { ...toFormValues(conflict) };
    for (const k of Object.keys(mine) as (keyof PolicyFormValues)[]) if (mine[k] !== before[k]) (merged as Record<string, unknown>)[k] = mine[k];
    setBase(conflict);
    setConflict(null);
    reset(merged);
    const update = toUpdate(conflict, merged);
    if (diffPolicy(conflict, update).length) setPending(update);
  };

  const discard = () => {
    if (!conflict) return;
    setBase(conflict);
    reset(toFormValues(conflict));
    setConflict(null);
  };

  const err = (name: keyof PolicyFormValues) =>
    errors[name] ? { 'aria-invalid': true, 'aria-describedby': `${name}-error` } : {};
  const errorText = (name: keyof PolicyFormValues) =>
    errors[name] && <span id={`${name}-error`} className="font-normal text-crit-ink">{errors[name]?.message}</span>;

  return (
    <div className="flex flex-col gap-5">
      {conflict && <ConflictNotice base={base} current={conflict} onApply={applyOnTop} onDiscard={discard} />}
      <form onSubmit={(e) => void review(e)} noValidate className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 text-sm font-semibold">
            <label htmlFor="policy-primary">{t.field.primaryStorage}</label>
            <select id="policy-primary" {...register('primaryStorage')} className={control}>
              {STORAGES.map((s) => <option key={s} value={s}>{t.storage[s]}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5 text-sm font-semibold">
            <label htmlFor="policy-fallback">{t.field.fallbackStorage}</label>
            <select id="policy-fallback" {...register('fallbackStorage')} {...err('fallbackStorage')} className={control}>
              <option value="none">{t.noFallback}</option>
              {STORAGES.map((s) => <option key={s} value={s}>{t.storage[s]}</option>)}
            </select>
            {errorText('fallbackStorage')}
          </div>
          <div className="flex flex-col gap-1.5 text-sm font-semibold">
            <label htmlFor="policy-chunk">{t.chunkSizeMiB}</label>
            <input id="policy-chunk" type="number" min={1} max={32} step={1} {...register('chunkSizeMiB', { valueAsNumber: true })} {...err('chunkSizeMiB')} aria-describedby={errors.chunkSizeMiB ? 'chunkSizeMiB-error' : 'policy-chunk-hint'} className={control} />
            <span id="policy-chunk-hint" className="font-normal text-ink-2">{t.chunkHint}</span>
            {errorText('chunkSizeMiB')}
          </div>
          <div className="flex flex-col gap-1.5 text-sm font-semibold">
            <label htmlFor="policy-parallel">{t.field.maxParallel}</label>
            <input id="policy-parallel" type="number" min={1} max={6} step={1} {...register('maxParallel', { valueAsNumber: true })} {...err('maxParallel')} aria-describedby={errors.maxParallel ? 'maxParallel-error' : 'policy-parallel-hint'} className={control} />
            <span id="policy-parallel-hint" className="font-normal text-ink-2">{t.parallelHint}</span>
            {errorText('maxParallel')}
          </div>
        </div>
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="flex items-center gap-2 font-semibold">
            <input type="checkbox" {...register('encryptionAtRest')} disabled={policy.encryptionLocked} aria-describedby={policy.encryptionLocked ? 'policy-enc-note' : undefined} className="size-4 accent-(--color-primary)" />
            {t.field.encryptionAtRest}
            {policy.encryptionAlgorithm && <span className="font-normal text-ink-2">({policy.encryptionAlgorithm})</span>}
          </label>
          {policy.encryptionLocked && <span id="policy-enc-note" className="text-ink-2">{t.encryptionLockedNote}</span>}
          {errorText('encryptionAtRest')}
        </div>
        <p className="rounded-panel bg-info-tint px-4 py-3 text-sm text-info-ink">{t.inFlightNote}</p>
        {failure && <p role="alert" className="rounded-panel border border-crit bg-crit-tint px-4 py-3 font-semibold text-crit-ink">{failure}</p>}
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={save.isPending || !!conflict}>{t.review}</Button>
          <p role="status" className="font-semibold text-ok-ink">
            {saved !== null ? t.saved(saved) : noChanges ? <span className="text-ink-2">{t.noChanges}</span> : null}
          </p>
        </div>
      </form>
      <DiffDialog
        open={pending !== null}
        category={t.category[policy.category]}
        baseVersion={base.version}
        rows={pending ? diffPolicy(base, pending) : []}
        saving={save.isPending}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      />
    </div>
  );
}
