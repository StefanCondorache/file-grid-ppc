import { formatBytes, formatInt } from '@/lib/i18n/format';
import { ro } from '@/lib/i18n/ro';
import { toStorage, type PolicyChange, type PolicyDoc, type PolicyUpdate } from './types';

const t = ro.policies;
type Field = keyof typeof t.field;
export type DiffRow = { field: string; from: string; to: string };

const FIELDS: Field[] = ['primaryStorage', 'fallbackStorage', 'encryptionAtRest', 'chunkSize', 'maxParallel', 'maxFileSize', 'allowedTypes', 'retentionDays'];

/** One value as the UI shows it; also used for the server's history entries, whose values are strings. */
export function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return field === 'fallbackStorage' ? t.noFallback : '—';
  switch (field) {
    case 'primaryStorage':
    case 'fallbackStorage': {
      const s = toStorage(value);
      return s ? t.storage[s] : String(value);
    }
    case 'encryptionAtRest':
      return value === true || value === 'true' ? t.yes : t.no;
    case 'chunkSize':
    case 'maxFileSize':
      return formatBytes(Number(value));
    case 'maxParallel':
    case 'retentionDays':
      return formatInt(Number(value));
    case 'allowedTypes':
      return Array.isArray(value) ? value.join(', ') || '—' : String(value);
    default:
      return String(value);
  }
}

export const fieldLabel = (field: string): string => (t.field as Record<string, string>)[field] ?? field;

/** The changed fields only, labelled in Romanian, in a fixed order. */
export function diffPolicy(a: PolicyDoc | PolicyUpdate, b: PolicyDoc | PolicyUpdate): DiffRow[] {
  return FIELDS.flatMap((f) => {
    const from = formatValue(f, a[f]);
    const to = formatValue(f, b[f]);
    return from === to ? [] : [{ field: fieldLabel(f), from, to }];
  });
}

export function describeChange(c: PolicyChange): DiffRow {
  return { field: fieldLabel(c.field), from: formatValue(c.field, c.from), to: formatValue(c.field, c.to) };
}
