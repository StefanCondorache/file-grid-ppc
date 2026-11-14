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

/** Upload screen, tray and engine copy (slice 6b). */
export const upload = {
  stateLabel,
  failure,
  /** Row label of a connection document before the server names it: never the file name (personal data). */
  connectionLabel: (requestNumber: string) => `Document racordare nr. ${requestNumber}`,
  validation: {
    empty: 'Fișierul este gol.',
    tooLarge: (limit: string) => `Fișierul depășește ${limit}, limita politicii.`,
    typeNotAllowed: (mime: string) => `Tipul ${mime} nu este permis pentru această categorie.`,
  },
} as const;
