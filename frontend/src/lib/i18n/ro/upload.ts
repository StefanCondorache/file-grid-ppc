import type { FailReason, PauseReason, StorageId, UploadState } from '@/lib/upload/types';

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

const failReason: Record<FailReason, string> = {
  forbidden: 'Rolul activ nu are dreptul să încarce în această categorie.',
  upload_gone: 'Încărcarea nu mai există pe server (anulată sau expirată). Pornește-o din nou.',
  too_large: 'Fișierul depășește limita politicii.',
  policy_violation: 'Fișierul nu respectă politica categoriei.',
  file_changed: 'Fișierul s-a modificat pe disc în timpul încărcării.',
  different_file: 'Fișierul ales este diferit de cel început.',
  checksum_mismatch: 'Amprenta nu coincide. Fișierul nu a fost păstrat.',
  retries_exhausted: 'Serverul nu a răspuns după 10 încercări. Apasă „Reia” ca să continui de unde a rămas.',
  unknown: 'Încărcarea a eșuat.',
};

const pauseReason: Record<PauseReason, string> = {
  user: 'Pusă în pauză. Părțile trimise rămân pe server.',
  offline: 'Fără rețea. Reluăm automat.',
  session: 'Sesiunea a expirat. Intră din nou în cont; încărcarea continuă singură.',
  logout: 'Te-ai deconectat. Încărcarea continuă după ce intri din nou în cont.',
};

export const STORAGE_LABEL: Record<StorageId, string> = { s3: 'S3', ftp: 'FTP', db: 'PostgreSQL' };

/** Upload screen, tray and engine copy (slice 6b). */
export const upload = {
  stateLabel,
  failReason,
  pauseReason,
  validation: {
    empty: 'Fișierul este gol.',
    tooLarge: (limit: string) => `Fișierul depășește ${limit}, limita politicii.`,
    typeNotAllowed: (mime: string) => `Tipul ${mime} nu este permis pentru această categorie.`,
  },
  storageDown: (storage: string) => `${storage} nu este disponibil. Celelalte categorii funcționează normal. Reîncercăm automat.`,
  offline: 'Fără rețea. Reluăm automat când revine conexiunea.',
  retrying: 'Reîncercare automată în curs.',
  needsFile: 'Alege din nou fișierul ca să continuăm. Verificăm că este același.',
  needsPermission: 'Permite accesul la fișier ca să continuăm.',
  metadataLost: 'Datele cererii nu au fost păstrate după reîncărcarea paginii. Pornește din nou încărcarea.',
} as const;
