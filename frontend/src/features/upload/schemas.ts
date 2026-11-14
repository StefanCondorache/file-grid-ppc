/**
 * Upload metadata forms (FE-02, FA-11): hand-written Zod schemas with Romanian messages and the UI-only rules (CNP
 * checksum). Each one parses the form values into the request metadata of its category and is tied at compile time
 * to both the real contract (lib/upload/contract.ts, docs/api.md) and the generated request types.
 */
import { z } from 'zod';
import type { components } from '@/lib/api/schema';
import { ro } from '@/lib/i18n/ro';
import type { ConnectionMetadata, DocumentType, DroneMetadata, FaultMetadata, Severity, Zone } from '@/lib/upload/contract';

type Generated = components['schemas'];

export const ZONES = ['muntenia', 'banat', 'dobrogea'] as const satisfies readonly Zone[];
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const satisfies readonly Severity[];
export const DOCUMENT_TYPES = ['cerere', 'act_identitate', 'aviz'] as const satisfies readonly DocumentType[];

/** The backend's length limits (backend/src/uploads/upload.schemas.ts). */
export const MAX_LENGTH = { substation: 120, lineSection: 120, requestNumber: 40, applicantName: 200 } as const;

/** Weights of the control digit of the Romanian personal numeric code (CNP), digits 1 to 12. */
const CNP_WEIGHTS = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9] as const;

/**
 * The official CNP check: 13 digits, the first one 1–9, and the 13th equal to (Σ digit·weight) mod 11, where a
 * remainder of 10 gives 1. A convenience only: the backend seals the value and stays the authority (threat-model §5).
 */
export function cnpIsValid(cnp: string): boolean {
  if (!/^[1-9]\d{12}$/.test(cnp)) return false;
  const sum = CNP_WEIGHTS.reduce((acc, w, i) => acc + w * Number(cnp[i]), 0);
  const control = sum % 11 === 10 ? 1 : sum % 11;
  return control === Number(cnp[12]);
}

const e = ro.upload.form.errors;

const text = (required: string, max: number) => z.string().trim().min(1, required).max(max, e.tooLong(max));

/** A `<select>` starts on the empty "Alege…" option: anything but a listed value is the "choose" message. */
const choice = <const T extends readonly [string, ...string[]]>(values: T, message: string) => z.enum(values, { error: message });

/** `<input type="datetime-local">` (local time, no offset) → ISO 8601 in UTC, which the backend's offset check accepts. */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;
const localDateTime = (message: string) =>
  z
    .string()
    .refine((v) => LOCAL_DATE_TIME.test(v) && !Number.isNaN(new Date(v).getTime()), message)
    .transform((v) => new Date(v).toISOString());

/** Spaces and dashes are dropped (a pasted "1960101 410019"), then the format and the checksum are checked. */
const cnp = z
  .string()
  .overwrite((v) => v.replace(/[\s-]/g, ''))
  .superRefine((v, ctx) => {
    if (!/^\d{13}$/.test(v)) ctx.addIssue({ code: 'custom', message: e.cnpFormat });
    else if (v.startsWith('0')) ctx.addIssue({ code: 'custom', message: e.cnpFirstDigit });
    else if (!cnpIsValid(v)) ctx.addIssue({ code: 'custom', message: e.cnpChecksum });
  });

export const faultMetadataSchema = z.object({
  kind: z.literal('fault'),
  zone: choice(ZONES, e.zone),
  substation: text(e.substation, MAX_LENGTH.substation),
  eventTime: localDateTime(e.eventTime),
  severity: choice(SEVERITIES, e.severity),
}) satisfies z.ZodType<FaultMetadata & Generated['FaultMetadata']>;

/** Personal data (applicant name, CNP): sent once at create, never persisted in the browser (pii.ts, SR-12). */
export const connectionMetadataSchema = z.object({
  kind: z.literal('connection'),
  requestNumber: text(e.requestNumber, MAX_LENGTH.requestNumber),
  documentType: choice(DOCUMENT_TYPES, e.documentType),
  applicantName: text(e.applicantName, MAX_LENGTH.applicantName),
  cnp,
  /** Optional: the empty "—" option sends no zone. */
  zone: z
    .enum(['', ...ZONES])
    .optional()
    .transform((v) => (v ? v : undefined)),
}) satisfies z.ZodType<ConnectionMetadata & Generated['ConnectionMetadataInput']>;

export const droneMetadataSchema = z.object({
  kind: z.literal('drone'),
  lineSection: text(e.lineSection, MAX_LENGTH.lineSection),
  zone: choice(ZONES, e.zone),
  inspectionDate: z.iso.date(e.inspectionDate),
}) satisfies z.ZodType<DroneMetadata & Generated['DroneMetadata']>;

export type FaultForm = z.input<typeof faultMetadataSchema>;
export type ConnectionForm = z.input<typeof connectionMetadataSchema>;
export type DroneForm = z.input<typeof droneMetadataSchema>;
