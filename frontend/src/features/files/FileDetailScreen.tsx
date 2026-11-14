'use client';

import { ArrowLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { SafeName } from '@/components/SafeName';
import { Button } from '@/components/ui/button';
import { Tag } from '@/components/ui/tag';
import { CustodyTimeline } from '@/features/integrity/CustodyTimeline';
import { TraceWaterfall } from '@/features/integrity/TraceWaterfall';
import { ApiError } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { formatBytes, formatDateTime, formatInt } from '@/lib/i18n/format';
import type { DocumentType, Severity } from '@/lib/upload/contract';
import { DEFAULT_FILTERS, toSearchParams } from './filters';
import { FileDownloadSlot } from './FileDownloadSlot';
import { CATEGORY_DOT, EncryptedTag, StorageTag } from './FilesTable';
import { HashPair } from './HashPair';
import { IntegrityBadge } from './IntegrityBadge';
import { OriginTag } from './OriginTag';
import { PiiField } from './PiiField';
import { useFileDetail, type FileDetail } from './queries';
import { SeverityLevel } from './SeverityLevel';
import { StoragePolicyPanel } from './StoragePolicyPanel';

const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
const DOCUMENT_TYPES: readonly DocumentType[] = ['cerere', 'act_identitate', 'aviz'];

/** A non-empty string from untrusted metadata, else null. */
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const isoTime = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const isoDate = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null);

/** A calendar day (`YYYY-MM-DD`) as the Romanian date, without shifting it through a time zone. */
const day = new Intl.DateTimeFormat('ro-RO', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });

/** Untrusted text from metadata: inert, direction-isolated, wrapping (SR-7). */
function Untrusted({ value }: { value: string }) {
  return (
    <span dir="auto" className="[overflow-wrap:anywhere] [unicode-bidi:isolate]">
      {value}
    </span>
  );
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} className="tabular-nums">
      {formatDateTime(iso)}
    </time>
  );
}

type Row = { term: string; value: ReactNode };

/**
 * The fields of a file, read from known keys only (an allow-list), so a key the backend should never send can never
 * show: a storage path, or a personal value it forgot to mask (ADR-0013 "Risks"). Personal data only ever arrives
 * masked, as `applicantNameMasked` and `cnpMasked`, and is drawn through `PiiField`.
 */
function metadataRows(file: FileDetail, t: ReturnType<typeof useT>): Row[] {
  const m = t.files.detail.meta;
  const md = file.metadata ?? {};
  const rows: Row[] = [];
  const push = (term: string, value: ReactNode | null) => value !== null && rows.push({ term, value });
  switch (file.category) {
    case 'fault_records': {
      const substation = text(md.substation);
      const eventTime = isoTime(md.eventTime);
      const severity = SEVERITIES.find((s) => s === md.severity);
      push(m.substation, substation && <Untrusted value={substation} />);
      push(m.eventTime, eventTime && <When iso={eventTime} />);
      push(m.severity, severity ? <SeverityLevel severity={severity} /> : null);
      break;
    }
    case 'drone_videos': {
      const lineSection = text(md.lineSection);
      const inspectionDate = isoDate(md.inspectionDate);
      push(m.lineSection, lineSection && <Untrusted value={lineSection} />);
      push(m.inspectionDate, inspectionDate && <time dateTime={inspectionDate}>{day.format(new Date(`${inspectionDate}T00:00:00Z`))}</time>);
      break;
    }
    case 'connection_documents': {
      const requestNumber = text(md.requestNumber);
      const documentType = DOCUMENT_TYPES.find((d) => d === md.documentType);
      push(m.requestNumber, requestNumber && <Untrusted value={requestNumber} />);
      push(m.documentType, documentType ? m.documentTypes[documentType] : null);
      push(m.applicant, <PiiField kind="name" masked={text(md.applicantNameMasked)} />);
      push(m.cnp, <PiiField kind="cnp" masked={text(md.cnpMasked)} />);
      break;
    }
    case 'meter_readings': {
      const readings = typeof md.readings === 'number' && Number.isFinite(md.readings) ? md.readings : null;
      push(m.readings, readings === null ? null : <span className="tabular-nums">{formatInt(readings)}</span>);
      break;
    }
  }
  return rows;
}

function MetadataPanel({ file }: { file: FileDetail }) {
  const t = useT();
  const m = t.files.detail.meta;
  const rows: Row[] = [
    { term: m.category, value: t.files.categoryOne[file.category] ?? file.category },
    ...metadataRows(file, t),
    { term: m.zone, value: file.zone ? (t.files.zones[file.zone] ?? file.zone) : <span className="text-ink-3">{t.files.noZone}</span> },
    {
      term: m.size,
      value: (
        <span className="tabular-nums">
          {formatBytes(file.size)} <span className="text-ink-2">({m.bytes(formatInt(file.size))})</span>
        </span>
      ),
    },
    { term: m.type, value: <Untrusted value={file.mimeType} /> },
    { term: m.uploadedAt, value: <When iso={file.createdAt} /> },
    { term: m.uploadedBy, value: file.uploadedBy ? <Untrusted value={file.uploadedBy.displayName} /> : <span className="text-ink-2">{m.system}</span> },
    { term: m.origin, value: <OriginTag origin={file.origin} /> },
  ];
  return (
    <section aria-labelledby="file-meta-h" className="flex flex-col gap-3 rounded-card border border-border bg-surface p-6 shadow-e1">
      <h2 id="file-meta-h" className="text-lg font-bold">
        {m.title}
      </h2>
      <dl className="flex flex-col">
        {rows.map((r) => (
          <div key={r.term} className="grid grid-cols-1 gap-x-6 gap-y-0.5 border-t border-border py-2.5 first:border-t-0 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-sm font-semibold text-ink-2">{r.term}</dt>
            <dd className="min-w-0 text-sm">{r.value}</dd>
          </div>
        ))}
      </dl>
      {file.category === 'connection_documents' && <p className="text-[13px] text-ink-2">{m.personalNote}</p>}
    </section>
  );
}

function IntegrityPanel({ file }: { file: FileDetail }) {
  const t = useT();
  const d = t.files.detail.integrity;
  return (
    <section aria-labelledby="file-integrity-h" className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6 shadow-e1">
      <h2 id="file-integrity-h" className="text-lg font-bold">
        {d.title}
      </h2>
      <p className="text-[13px] text-ink-2">{d.about}</p>
      <HashPair client={file.clientSha256} server={file.serverSha256} corrupt={file.integrity === 'corrupt'} />
      <p className="text-[13px] text-ink-2">
        {file.lastVerifiedAt ? (
          <>
            {d.lastVerified} <When iso={file.lastVerifiedAt} />
          </>
        ) : (
          d.neverVerified
        )}
      </p>
    </section>
  );
}

function Header({ file }: { file: FileDetail }) {
  const t = useT();
  const d = t.files.detail;
  const when = formatDateTime(file.createdAt);
  return (
    <section aria-labelledby="file-name-h" className="flex flex-col gap-3 rounded-hero border border-border bg-surface p-6 shadow-e1">
      <span className="inline-flex items-center gap-2 text-xs font-semibold tracking-wide text-ink-2 uppercase">
        <span aria-hidden="true" className={cn('size-2.5 rounded-full', CATEGORY_DOT[file.category])} />
        {t.files.categoryOne[file.category] ?? file.category}
      </span>
      <h2 id="file-name-h" className="flex min-w-0 text-[28px] leading-tight font-bold tracking-tight">
        <SafeName name={file.displayName} className="max-w-full" />
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <IntegrityBadge state={file.integrity} />
        <StorageTag storage={file.storage} usedFallback={file.usedFallback} />
        {file.encryptedAtRest && <EncryptedTag />}
        <Tag>{d.policyTag(formatInt(file.policyVersion))}</Tag>
        <Tag className="tabular-nums">{formatBytes(file.size)}</Tag>
      </div>
      <p className="text-sm text-ink-2">
        {file.uploadedBy ? d.uploadedLine(when, file.uploadedBy.displayName) : d.generatedLine(when)}
        {file.zone && ` · ${t.files.zones[file.zone] ?? file.zone}`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <FileDownloadSlot fileId={file.id} />
      </div>
    </section>
  );
}

function Breadcrumb({ file }: { file: FileDetail }) {
  const t = useT();
  const list = toSearchParams({ ...DEFAULT_FILTERS, category: file.category }).toString();
  return (
    <nav aria-label={t.files.detail.breadcrumb}>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-ink-2">
        <li>
          <Link href="/files" className="font-semibold text-link hover:underline">
            {t.files.title}
          </Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight className="size-3.5" />
        </li>
        <li>
          <Link href={`/files?${list}`} className="font-semibold text-link hover:underline">
            {t.files.categories[file.category] ?? file.category}
          </Link>
        </li>
      </ol>
    </nav>
  );
}

function TracePanel({ traceId }: { traceId: string }) {
  const t = useT();
  return (
    <section aria-labelledby="file-trace-h" className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6 shadow-e1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="file-trace-h" className="text-lg font-bold">
          {t.files.trace.title}
        </h2>
        <Link href={`/traces/${encodeURIComponent(traceId)}`} className="text-sm font-semibold text-link hover:underline">
          {t.files.trace.openPage}
        </Link>
      </div>
      <TraceWaterfall traceId={traceId} />
    </section>
  );
}

function CustodyPanel({ fileId }: { fileId: string }) {
  const t = useT();
  return (
    <section aria-labelledby="file-custody-h" className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6 shadow-e1">
      <h2 id="file-custody-h" className="text-lg font-bold">
        {t.files.custody.title}
      </h2>
      <CustodyTimeline fileId={fileId} />
    </section>
  );
}

function Loading() {
  const t = useT();
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">{t.files.detail.loading}</span>
      <div aria-hidden="true" className="h-40 rounded-hero bg-sunken" />
      <div aria-hidden="true" className="grid gap-4 lg:grid-cols-2">
        <div className="h-56 rounded-card bg-sunken" />
        <div className="h-56 rounded-card bg-sunken" />
      </div>
    </div>
  );
}

function NotFound() {
  const t = useT();
  return (
    <EmptyState
      title={t.files.detail.notFound}
      body={t.files.detail.notFoundBody}
      action={
        <Button asChild variant="secondary" size="sm">
          <Link href="/files">
            <ArrowLeft aria-hidden="true" />
            {t.files.detail.back}
          </Link>
        </Button>
      }
    />
  );
}

/**
 * SC-05 Detaliu fișier (FE-05): which file, where it is stored and under which policy, and the proof that it is
 * intact (client and server SHA-256). Personal data shows masked only (FE-13). The page title stays fixed (set by the
 * route), so nothing from the file reaches `document.title`. Trace, custody, download and reveal join in 6c.6–6c.9.
 */
export function FileDetailScreen({ fileId }: { fileId: string }) {
  const detail = useFileDetail(fileId);
  if (detail.isPending) return <Loading />;
  if (detail.isError) {
    // The backend answers 404 both for an unknown id and for a category the active role may not see.
    if (detail.error instanceof ApiError && detail.error.status === 404) return <NotFound />;
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  }
  const file = detail.data;
  return (
    <div className="flex flex-col gap-5">
      <Breadcrumb file={file} />
      <Header file={file} />
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <IntegrityPanel file={file} />
        <StoragePolicyPanel file={file} />
      </div>
      <MetadataPanel file={file} />
      {file.uploadTraceId && <TracePanel traceId={file.uploadTraceId} />}
      <CustodyPanel fileId={file.id} />
    </div>
  );
}
