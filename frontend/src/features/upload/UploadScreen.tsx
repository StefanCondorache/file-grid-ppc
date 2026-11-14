'use client';

import { CircleAlert, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import { Forbidden } from '@/components/Forbidden';
import { SafeName } from '@/components/SafeName';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useMe } from '@/features/auth/queries';
import { roleLabel } from '@/features/auth/roles';
import { announce } from '@/lib/a11y/announcer';
import type { Capability } from '@/lib/api/types';
import { can } from '@/lib/auth/capabilities';
import { useT } from '@/lib/i18n';
import { METADATA_KIND, type UploadMetadata } from '@/lib/upload/contract';
import { uploadEngine } from '@/lib/upload/engine';
import { formatLimit, validateFile } from '@/lib/upload/plan';
import type { PolicySnapshot, UploadCategoryId } from '@/lib/upload/types';
import { CategoryPicker } from './CategoryPicker';
import { Dropzone, type PickedFile, type RejectedFile } from './Dropzone';
import { MetadataForm } from './MetadataForm';
import { formatTypes, PolicySummary } from './PolicySummary';
import { useUploadPolicies } from './queries';
import { UploadQueue } from './UploadQueue';

/** Tile order of the mockup; each category needs its own upload capability (FE-01). */
const ORDER: readonly UploadCategoryId[] = ['drone_videos', 'fault_records', 'connection_documents'];
const CAPABILITY: Record<UploadCategoryId, Capability> = {
  drone_videos: 'upload_drone',
  fault_records: 'upload_fault',
  connection_documents: 'upload_connection',
};

/** `?category=` takes the short alias (`drone`, like `/files?category=fault`) or the backend id. */
function fromParam(value: string | null): UploadCategoryId | undefined {
  return ORDER.find((c) => c === value || METADATA_KIND[c] === value);
}

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/** Splits files by the policy (Review Focus 5): refused ones never reach a request. Without a policy the engine checks. */
function screenFiles(files: readonly PickedFile[], policy: PolicySnapshot | undefined): { ok: PickedFile[]; refused: RejectedFile[] } {
  const ok: PickedFile[] = [];
  const refused: RejectedFile[] = [];
  for (const p of files) {
    const reasons = policy ? validateFile(p.file, policy) : [];
    if (reasons.length > 0) refused.push({ name: p.file.name, reasons });
    else ok.push(p);
  }
  return { ok, refused };
}

/**
 * Încărcare (SC-03, FE-02, beats 2–4): pick a category, give its metadata, choose or drop files and queue them. The
 * engine takes it from there (hash, parts, retries, resume); the queue below and the tray show its progress.
 */
export function UploadScreen() {
  const t = useT();
  const u = t.upload;
  const me = useMe().data;
  const router = useRouter();
  const search = useSearchParams();
  const policies = useUploadPolicies();
  const pickId = useId();
  const chosenId = useId();
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [refused, setRefused] = useState<RejectedFile[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  if (!me) return null; // the (app) layout renders screens only once `me` is known
  const allowed = ORDER.filter((c) => can(me, CAPABILITY[c]));
  const requested = fromParam(search.get('category'));
  const category = requested && allowed.includes(requested) ? requested : allowed[0];
  if (!category) return <Forbidden roleLabel={roleLabel(me.activeRole)} />;
  const policy = policies.data?.[category];

  function choose(next: UploadCategoryId) {
    if (next === category) return;
    // Files were checked against the other category's policy, and its metadata does not apply: start over.
    setPicked([]);
    setRefused([]);
    setFailure(null);
    router.replace(`/upload?category=${METADATA_KIND[next]}`, { scroll: false });
  }

  function onFiles(files: PickedFile[]) {
    const { ok, refused: bad } = screenFiles(files, policy);
    setRefused(bad);
    setPicked((prev) => [...prev, ...ok.filter((p) => !prev.some((q) => sameFile(q.file, p.file)))]);
    if (bad.length > 0) announce(u.screen.rejectedAnnouncement(bad.length), 'assertive');
  }

  function submit(metadata: UploadMetadata): boolean {
    // The policy may have changed since the files were chosen (beat 7): check again, still before any request.
    const { ok, refused: bad } = screenFiles(picked, policy);
    // Refusals of an earlier choice are done with; only what this check refuses is shown.
    setRefused(bad);
    if (bad.length > 0) announce(u.screen.rejectedAnnouncement(bad.length), 'assertive');
    if (ok.length === 0) {
      setPicked([]);
      return false;
    }
    try {
      for (const p of ok) uploadEngine.enqueue({ file: p.file, category, metadata, handle: p.handle });
    } catch {
      setFailure(u.screen.enqueueFailed);
      return false;
    }
    setPicked([]);
    setFailure(null);
    announce(u.screen.queued(ok.length));
    return true;
  }

  const hint = policy ? u.screen.hint(formatTypes(policy.allowedTypes), formatLimit(policy.maxFileSize), policy.version) : u.screen.hintNoPolicy;

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-3xl text-ink-2">{u.screen.intro}</p>
      <CategoryPicker categories={allowed} value={category} onChange={choose} policies={policies.data ?? {}} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="@container">
            <MetadataForm key={category} category={category} fileCount={picked.length} filesTargetId={pickId} onSubmit={submit}>
              <Dropzone buttonId={pickId} hint={hint} accept={policy?.allowedTypes.join(',') || undefined} rejected={refused} onFiles={onFiles} />
              {picked.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h3 id={chosenId} className="text-sm font-bold">
                    {u.screen.chosen}
                  </h3>
                  <ul aria-labelledby={chosenId} className="flex flex-col divide-y divide-border rounded-panel border border-border">
                    {picked.map((p, i) => (
                      <ChosenFile key={`${p.file.name}-${p.file.size}-${p.file.lastModified}`} file={p.file} onRemove={() => setPicked((prev) => prev.filter((_, j) => j !== i))} />
                    ))}
                  </ul>
                </div>
              )}
              {failure && (
                <p role="alert" className="flex items-start gap-1.5 text-sm font-semibold text-crit-ink">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {failure}
                </p>
              )}
            </MetadataForm>
          </Card>
          <UploadQueue />
        </div>
        <aside className="flex flex-col gap-6">
          <PolicySummary category={category} policy={policy} loading={policies.isPending} />
          <NetworkCard />
        </aside>
      </div>
    </div>
  );
}

function ChosenFile({ file, onRemove }: { file: File; onRemove(): void }) {
  const u = useT().upload;
  const nameId = useId();
  const buttonId = useId();
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span id={nameId} className="min-w-0 flex-1 font-semibold">
        <SafeName name={file.name} className="max-w-full" />
      </span>
      <span className="shrink-0 text-sm text-ink-2">{formatLimit(file.size)}</span>
      <Button id={buttonId} type="button" variant="quiet" size="sm" aria-labelledby={`${buttonId} ${nameId}`} onClick={onRemove}>
        <X aria-hidden="true" />
        {u.screen.remove}
      </Button>
    </li>
  );
}

/** What the transfer does on a bad network, in four steps (beat 2 narration). */
function NetworkCard() {
  const u = useT().upload;
  const titleId = useId();
  return (
    <Card aria-labelledby={titleId} className="flex flex-col gap-4">
      <h2 id={titleId} className="text-lg font-bold">
        {u.network.title}
      </h2>
      <ol className="flex flex-col gap-3">
        {u.network.steps.map((step, i) => (
          <li key={step} className="flex items-start gap-3">
            <span aria-hidden="true" className="grid size-[26px] shrink-0 place-items-center rounded-full bg-sunken text-[13px] font-bold">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
