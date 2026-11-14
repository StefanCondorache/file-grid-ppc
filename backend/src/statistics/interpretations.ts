import type { Category, StorageName } from '../common/domain';

/** Why each category lives where it does: the brief's requirements, in plain Romanian. */
export const CATEGORY_RATIONALE: Readonly<Record<Category, { storage: StorageName; why: string }>> =
  {
    meter_readings: {
      storage: 'db',
      why: 'Milioane de înregistrări mici: PostgreSQL le scrie tranzacțional, iar cheia unică pe readingId face imposibilă dublarea la reîncercări.',
    },
    fault_records: {
      storage: 's3',
      why: 'Fișiere medii care trebuie să fie disponibile repede: S3 are latență mică la scriere și citire și durabilitate ridicată.',
    },
    connection_documents: {
      storage: 's3',
      why: 'Date personale: se criptează AES-256-GCM înainte de scriere; S3 păstrează obiectele opace, iar accesul trece doar prin API, cu audit.',
    },
    drone_videos: {
      storage: 'ftp',
      why: 'Fișiere foarte mari, transferate secvențial: FTP le primește în flux, iar încărcarea pe părți permite reluarea după o cădere de rețea.',
    },
  };

export const STORAGE_LABEL: Readonly<Record<StorageName, string>> = {
  s3: 'S3',
  ftp: 'FTP',
  db: 'PostgreSQL',
};

export function formatMs(ms: number | null): string {
  if (ms === null) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${Math.round(ms)} ms`;
}

export function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 1000) / 10}`.replace('.', ',') + ' %';
}
