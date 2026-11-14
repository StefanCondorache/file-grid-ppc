import type { DocumentType, Severity, Zone } from '@/lib/upload/contract';
import type { FailReason, UploadState } from '@/lib/upload/types';

const stateLabel: Record<UploadState, string> = {
  queued: 'în așteptare',
  hashing: 'se calculează amprenta',
  uploading: 'se încarcă',
  paused: 'în pauză',
  connection_lost: 'conexiune pierdută',
  verifying: 'se verifică',
  verified: 'verificat',
  failed: 'eșuat',
  needs_file: 'alege din nou fișierul',
};

/** Why an upload failed (engine `failReason`), shown on the row. */
const failure: Record<FailReason, string> = {
  forbidden: 'Rolul tău nu poate încărca în această categorie.',
  upload_gone: 'Încărcarea nu mai există pe server. Pornește-o din nou.',
  too_large: 'Fișierul depășește limita politicii.',
  policy_violation: 'Fișierul nu respectă politica categoriei.',
  file_changed: 'Fișierul s-a modificat în timpul încărcării.',
  different_file: 'Fișierul ales este diferit de cel început.',
  checksum_mismatch: 'Amprenta nu coincide. Fișierul nu a fost păstrat.',
  retries_exhausted: 'Prea multe încercări eșuate. Apasă „Reia” pentru a continua.',
  unknown: 'Încărcarea a eșuat.',
};

const pluralRules = new Intl.PluralRules('ro');
const characters = { one: 'caracter', few: 'caractere', other: 'de caractere' } as const;

const zones: Record<Zone, string> = { muntenia: 'Muntenia', banat: 'Banat', dobrogea: 'Dobrogea' };
const severities: Record<Severity, string> = { low: 'Scăzută', medium: 'Medie', high: 'Ridicată', critical: 'Critică' };
const documentTypes: Record<DocumentType, string> = { cerere: 'Cerere', act_identitate: 'Act de identitate', aviz: 'Aviz' };

/** Metadata form: labels, hints and the reasons a field is refused (validated on submit, A11Y-10). */
const form = {
  required: '(obligatoriu)',
  optional: '(opțional)',
  choose: 'Alege…',
  zone: 'Zonă',
  substation: 'Stație sau post de transformare',
  eventTime: 'Data și ora avariei',
  severity: 'Severitate',
  requestNumber: 'Număr cerere',
  documentType: 'Tip document',
  applicantName: 'Nume solicitant',
  cnp: 'CNP',
  cnpHint: '13 cifre, fără spații sau liniuțe',
  lineSection: 'Linie / tronson',
  inspectionDate: 'Data inspecției',
  zones,
  severities,
  documentTypes,
  errors: {
    zone: 'Alege zona.',
    substation: 'Introdu stația sau postul de transformare.',
    eventTime: 'Introdu data și ora avariei.',
    severity: 'Alege severitatea.',
    requestNumber: 'Introdu numărul cererii.',
    documentType: 'Alege tipul documentului.',
    applicantName: 'Introdu numele solicitantului.',
    cnpFormat: 'Introdu un CNP din 13 cifre.',
    cnpFirstDigit: 'CNP-ul nu poate începe cu 0.',
    cnpChecksum: 'CNP-ul nu este valid: ultima cifră (cifra de control) nu se potrivește cu celelalte. Verifică cifrele.',
    lineSection: 'Introdu linia sau tronsonul.',
    inspectionDate: 'Introdu data inspecției.',
    tooLong: (max: number) => `Cel mult ${max} ${characters[pluralRules.select(max) as keyof typeof characters] ?? characters.other}.`,
  },
};

/** Upload screen, tray and engine copy (slice 6b). */
export const upload = {
  stateLabel,
  failure,
  /** Row label of a connection document before the server names it: never the file name (personal data). */
  connectionLabel: (requestNumber: string) => `Document racordare nr. ${requestNumber}`,
  form,
  validation: {
    empty: 'Fișierul este gol.',
    tooLarge: (limit: string) => `Fișierul depășește ${limit}, limita politicii.`,
    typeNotAllowed: (mime: string) => `Tipul ${mime} nu este permis pentru această categorie.`,
  },
} as const;
