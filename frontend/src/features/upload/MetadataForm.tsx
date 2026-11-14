'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useForm, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import type { ConnectionMetadata, DroneMetadata, FaultMetadata, UploadMetadata } from '@/lib/upload/contract';
import type { UploadCategoryId } from '@/lib/upload/types';
import {
  connectionMetadataSchema,
  DOCUMENT_TYPES,
  droneMetadataSchema,
  faultMetadataSchema,
  MAX_LENGTH,
  SEVERITIES,
  ZONES,
  type ConnectionForm as ConnectionValues,
  type DroneForm as DroneValues,
  type FaultForm as FaultValues,
} from './schemas';

export interface MetadataFormProps {
  category: UploadCategoryId;
  /** Files chosen so far: none is a form error ("Alege cel puțin un fișier."). */
  fileCount: number;
  /** Id of the "Alege fișiere" button: the error summary links there when no file is chosen. */
  filesTargetId: string;
  /** Called with valid metadata and at least one file; returns true once the files are queued. */
  onSubmit(metadata: UploadMetadata): boolean | void;
  /** The drop zone and the chosen files, between the fields and the submit button. */
  children?: ReactNode;
}

/**
 * The metadata of the chosen category and the files it applies to (FE-02). One form per batch, so every file of a
 * batch gets the same metadata without typing it again (WCAG 3.3.7). Validated on submit, with an error summary that
 * takes the focus and links to each field (A11Y-10). Personal data (connection documents) lives only in this form's
 * state: it is cleared as soon as the files are queued and is never stored (SR-12, TM-10).
 */
export function MetadataForm(props: MetadataFormProps) {
  switch (props.category) {
    case 'fault_records':
      return <FaultForm {...props} />;
    case 'connection_documents':
      return <ConnectionForm {...props} />;
    case 'drone_videos':
      return <DroneForm {...props} />;
  }
}

// ---- the three forms ---------------------------------------------------------------------------------------
// The first check runs on submit (A11Y-10); after that a field is checked again as it changes, so a fixed error
// leaves before the next click. Re-checking on blur instead would remove error lines under the pointer and move the
// submit button between mousedown and mouseup, losing the click.

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDateTime = (d: Date) => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function FaultForm({ children, ...props }: MetadataFormProps) {
  const t = useT().upload;
  // A fault is usually uploaded right after it happened: the time starts at "now".
  const [defaults] = useState<FaultValues>(() => ({ kind: 'fault', zone: '', substation: '', eventTime: localDateTime(new Date()), severity: '' }));
  const form = useForm<FaultValues, unknown, FaultMetadata>({ resolver: zodResolver(faultMetadataSchema), defaultValues: defaults });
  return (
    <FormShell
      {...props}
      form={form}
      title={t.categories.fault_records.details}
      order={['zone', 'substation', 'eventTime', 'severity']}
      slot={children}
      fields={(f) => (
        <div className="grid gap-4 @lg:grid-cols-2">
          {f.select({ name: 'zone', label: t.form.zone, options: ZONES.map((z) => [z, t.form.zones[z]]) })}
          {f.input({ name: 'substation', label: t.form.substation, maxLength: MAX_LENGTH.substation, autoComplete: 'off' })}
          {f.input({ name: 'eventTime', label: t.form.eventTime, type: 'datetime-local' })}
          {f.select({ name: 'severity', label: t.form.severity, options: SEVERITIES.map((s) => [s, t.form.severities[s]]) })}
        </div>
      )}
    />
  );
}

function ConnectionForm({ children, ...props }: MetadataFormProps) {
  const t = useT().upload;
  const [defaults] = useState<ConnectionValues>(() => ({ kind: 'connection', requestNumber: '', documentType: '', applicantName: '', cnp: '', zone: '' }));
  const form = useForm<ConnectionValues, unknown, ConnectionMetadata>({
    resolver: zodResolver(connectionMetadataSchema),
    defaultValues: defaults,
  });
  return (
    <FormShell
      {...props}
      form={form}
      title={t.categories.connection_documents.details}
      order={['requestNumber', 'documentType', 'applicantName', 'cnp', 'zone']}
      personal={['applicantName', 'cnp']}
      slot={children}
      fields={(f) => (
        <>
          <div className="grid gap-4 @lg:grid-cols-2">
            {f.input({ name: 'requestNumber', label: t.form.requestNumber, maxLength: MAX_LENGTH.requestNumber, autoComplete: 'off' })}
            {f.select({ name: 'documentType', label: t.form.documentType, options: DOCUMENT_TYPES.map((d) => [d, t.form.documentTypes[d]]) })}
            {/* Personal data: never remembered, spell-checked or capitalised by the browser (SR-12). */}
            {f.input({ name: 'applicantName', label: t.form.applicantName, maxLength: MAX_LENGTH.applicantName, autoComplete: 'off', spellCheck: false, autoCapitalize: 'off' })}
            {/* A numeric text field: never type=number (leading digits, checksum), never type=password (A11Y-10). */}
            {f.input({
              name: 'cnp',
              label: t.form.cnp,
              hint: t.form.cnpHint,
              type: 'text',
              inputMode: 'numeric',
              maxLength: 13,
              autoComplete: 'off',
              spellCheck: false,
              autoCapitalize: 'off',
            })}
            {f.select({ name: 'zone', label: t.form.zone, options: ZONES.map((z) => [z, t.form.zones[z]]), optional: true })}
          </div>
          <p className="flex items-start gap-2 text-sm text-ink-2">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t.screen.personalData}
          </p>
        </>
      )}
    />
  );
}

function DroneForm({ children, ...props }: MetadataFormProps) {
  const t = useT().upload;
  const [defaults] = useState<DroneValues>(() => ({ kind: 'drone', lineSection: '', zone: '', inspectionDate: localDate(new Date()) }));
  const form = useForm<DroneValues, unknown, DroneMetadata>({ resolver: zodResolver(droneMetadataSchema), defaultValues: defaults });
  return (
    <FormShell
      {...props}
      form={form}
      title={t.categories.drone_videos.details}
      order={['lineSection', 'zone', 'inspectionDate']}
      slot={children}
      fields={(f) => (
        <div className="grid gap-4 @lg:grid-cols-2 @3xl:grid-cols-3">
          {f.input({ name: 'lineSection', label: t.form.lineSection, maxLength: MAX_LENGTH.lineSection, autoComplete: 'off' })}
          {f.select({ name: 'zone', label: t.form.zone, options: ZONES.map((z) => [z, t.form.zones[z]]) })}
          {f.input({ name: 'inspectionDate', label: t.form.inspectionDate, type: 'date' })}
        </div>
      )}
    />
  );
}

// ---- shared shell: fields, error summary, the files slot, submit -------------------------------------------

const CONTROL =
  'h-11 w-full rounded-control border-[1.5px] border-input bg-surface px-3 text-[15px] font-normal text-ink aria-[invalid=true]:border-crit';

type InputSpec<V extends FieldValues> = { name: Path<V>; label: string; hint?: string } & Omit<ComponentProps<'input'>, 'name' | 'id' | 'children'>;
type SelectSpec<V extends FieldValues> = { name: Path<V>; label: string; options: readonly (readonly [string, string])[]; optional?: boolean };

/** Render helpers (plain functions, not components, so a re-render never remounts a field and loses its focus). */
interface Fields<V extends FieldValues> {
  input(spec: InputSpec<V>): ReactNode;
  select(spec: SelectSpec<V>): ReactNode;
}

interface ShellProps<V extends FieldValues, O extends UploadMetadata> {
  form: UseFormReturn<V, unknown, O>;
  title: string;
  /** Field order of the error summary (the visual order). */
  order: Path<V>[];
  /** Fields holding personal data, cleared once the files are queued. */
  personal?: Path<V>[];
  fields(f: Fields<V>): ReactNode;
  slot?: ReactNode;
  fileCount: number;
  filesTargetId: string;
  onSubmit(metadata: O): boolean | void;
}

function FormShell<V extends FieldValues, O extends UploadMetadata>({ form, title, order, personal = [], fields, slot, fileCount, filesTargetId, onSubmit }: ShellProps<V, O>) {
  const t = useT().upload;
  const uid = useId();
  const fieldId = (name: string) => `${uid}-${name}`;
  const summaryRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [filesMissing, setFilesMissing] = useState(false);
  // Reading `errors` from formState subscribes this component to them. The forms are flat: a name is a key.
  const errors = form.formState.errors as Record<string, { message?: unknown } | undefined>;
  const errorOf = (name: Path<V>): string | undefined => {
    const message = errors[name]?.message;
    return typeof message === 'string' ? message : undefined;
  };

  // Each failed submit moves the focus to the summary, which lists what to fix (A11Y-10).
  useEffect(() => {
    if (attempt > 0) summaryRef.current?.focus();
  }, [attempt]);

  const submit = form.handleSubmit(
    (metadata) => {
      if (fileCount === 0) {
        setFilesMissing(true);
        setAttempt((a) => a + 1);
        return;
      }
      setFilesMissing(false);
      if (onSubmit(metadata) === true) for (const name of personal) form.resetField(name);
    },
    () => {
      setFilesMissing(fileCount === 0);
      setAttempt((a) => a + 1);
    },
  );

  const problems: { id: string; message: string }[] = [];
  for (const name of order) {
    const message = errorOf(name);
    if (message) problems.push({ id: fieldId(name), message });
  }
  const noFiles = filesMissing && fileCount === 0;
  if (noFiles) problems.push({ id: filesTargetId, message: t.screen.noFiles });

  const label = (name: Path<V>, text: string, optional = false) => (
    <label htmlFor={fieldId(name)}>
      {text} <span className="font-normal text-ink-2">{optional ? t.form.optional : t.form.required}</span>
    </label>
  );
  const describedBy = (name: Path<V>, hint?: string) =>
    [hint ? `${fieldId(name)}-hint` : null, errorOf(name) ? `${fieldId(name)}-error` : null].filter(Boolean).join(' ') || undefined;
  const below = (name: Path<V>, hint?: string) => {
    const message = errorOf(name);
    return (
      <>
        {hint && (
          <span id={`${fieldId(name)}-hint`} className="font-normal text-ink-2">
            {hint}
          </span>
        )}
        {message && (
          <span id={`${fieldId(name)}-error`} className="flex items-start gap-1.5 font-semibold text-crit-ink">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {message}
          </span>
        )}
      </>
    );
  };

  const helpers: Fields<V> = {
    input: ({ name, label: text, hint, className, ...attrs }) => (
      <div key={name} className="flex flex-col gap-1.5 text-sm font-semibold">
        {label(name, text)}
        <input
          id={fieldId(name)}
          aria-required="true"
          aria-invalid={errorOf(name) ? true : undefined}
          aria-describedby={describedBy(name, hint)}
          className={cn(CONTROL, className)}
          {...attrs}
          {...form.register(name)}
        />
        {below(name, hint)}
      </div>
    ),
    select: ({ name, label: text, options, optional = false }) => (
      <div key={name} className="flex flex-col gap-1.5 text-sm font-semibold">
        {label(name, text, optional)}
        <select
          id={fieldId(name)}
          aria-required={optional ? undefined : true}
          aria-invalid={errorOf(name) ? true : undefined}
          aria-describedby={describedBy(name)}
          className={CONTROL}
          {...form.register(name)}
        >
          <option value="">{optional ? t.form.unspecified : t.form.choose}</option>
          {options.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
        {below(name)}
      </div>
    ),
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} aria-labelledby={`${uid}-title`} className="flex flex-col gap-5">
      <h2 id={`${uid}-title`} className="text-lg font-bold">
        {title}
      </h2>
      {attempt > 0 && problems.length > 0 && (
        <div ref={summaryRef} tabIndex={-1} className="flex flex-col gap-2 rounded-panel border-[1.5px] border-crit bg-crit-tint p-4 text-crit-ink">
          <h3 className="flex items-center gap-2 text-base font-bold">
            <CircleAlert aria-hidden="true" className="size-5" />
            {t.screen.errorSummary(problems.length)}
          </h3>
          <ul className="flex list-disc flex-col gap-1 pl-10 text-sm">
            {problems.map((p) => (
              <li key={p.id}>
                <a
                  href={`#${p.id}`}
                  className="font-semibold text-crit-ink underline underline-offset-2"
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(p.id)?.focus();
                  }}
                >
                  {p.message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {fields(helpers)}
      {slot}
      {noFiles && (
        <p className="flex items-start gap-1.5 text-sm font-semibold text-crit-ink">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t.screen.noFiles}
        </p>
      )}
      <div>
        <Button type="submit" size="lg">
          {t.screen.submit(fileCount)}
        </Button>
      </div>
    </form>
  );
}
