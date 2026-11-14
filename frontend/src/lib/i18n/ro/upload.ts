import type { UploadState } from '@/lib/upload/types';

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

/** Upload screen, tray and engine copy (slice 6b). */
export const upload = {
  stateLabel,
  validation: {
    empty: 'Fișierul este gol.',
    tooLarge: (limit: string) => `Fișierul depășește ${limit}, limita politicii.`,
    typeNotAllowed: (mime: string) => `Tipul ${mime} nu este permis pentru această categorie.`,
  },
} as const;
