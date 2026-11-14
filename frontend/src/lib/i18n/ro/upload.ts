import type { DocumentType, Severity, Zone } from '@/lib/upload/contract';
import type { FailReason, StorageId, UploadCategoryId, UploadState } from '@/lib/upload/types';
import { formatInt } from '../format';

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

/** "1 fișier", "2 fișiere", "20 de fișiere": Romanian plural forms, each with `#` for the number. */
function count(n: number, forms: { one: string; few: string; other: string }): string {
  const form = forms[pluralRules.select(n) as keyof typeof forms] ?? forms.other;
  return form.replace('#', formatInt(n));
}
const files = (n: number) => count(n, { one: '# fișier', few: '# fișiere', other: '# de fișiere' });

const zones: Record<Zone, string> = { muntenia: 'Muntenia', banat: 'Banat', dobrogea: 'Dobrogea' };
const severities: Record<Severity, string> = { low: 'Scăzută', medium: 'Medie', high: 'Ridicată', critical: 'Critică' };
const documentTypes: Record<DocumentType, string> = { cerere: 'Cerere', act_identitate: 'Act de identitate', aviz: 'Aviz' };

/** Metadata form: labels, hints and the reasons a field is refused (validated on submit, A11Y-10). */
const form = {
  required: '(obligatoriu)',
  optional: '(opțional)',
  choose: 'Alege…',
  unspecified: 'Nespecificată',
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

const categories: Record<UploadCategoryId, { title: string; hint: string; details: string; short: string }> = {
  drone_videos: { title: 'Video inspecție dronă', hint: '100\u00A0MB – 1\u00A0GB+', details: 'Detalii inspecție', short: 'Video dronă' },
  fault_records: { title: 'Înregistrare de avarie', hint: '1–10\u00A0MB · disponibilă imediat pentru dispecerat', details: 'Detalii avarie', short: 'Avarii' },
  connection_documents: { title: 'Document de racordare', hint: '0,1–10\u00A0MB · date personale', details: 'Detalii document', short: 'Documente racordare' },
};

/** Storage labels shown to people (docs/api.md: the ids stay s3, ftp, db). */
const storages: Record<StorageId, string> = { s3: 'S3', ftp: 'FTP', db: 'PostgreSQL' };

/** The Încărcare screen (SC-03). */
const screen = {
  intro: 'Transferul continuă singur dacă se pierde conexiunea. Amprenta SHA-256 dovedește că fișierul stocat este identic cu cel trimis.',
  category: 'Categorie',
  chosen: 'Fișiere alese',
  remove: 'Elimină',
  submit: (n: number) => (n > 0 ? `Încarcă ${files(n)}` : 'Încarcă'),
  noFiles: 'Alege cel puțin un fișier.',
  errorSummary: (n: number) => (n === 1 ? 'Există o eroare' : `Există ${count(n, { one: '# eroare', few: '# erori', other: '# de erori' })}`),
  queued: (n: number) => (n === 1 ? 'Un fișier a fost adăugat în coada de încărcare.' : `${files(n)} au fost adăugate în coada de încărcare.`),
  rejectedAnnouncement: (n: number) => (n === 1 ? 'Un fișier a fost refuzat. Vezi motivul sub zona de încărcare.' : `${files(n)} au fost refuzate. Vezi motivele sub zona de încărcare.`),
  hint: (types: string, limit: string, version: number) => `${types} · maximum ${limit} (politica v${version})`,
  hintNoPolicy: 'limitele politicii se verifică la pornire',
  anyType: 'orice tip',
  personalData: 'Numele și CNP-ul se trimit o singură dată, la pornirea încărcării, și sunt criptate pe server. Nu rămân în browser.',
  enqueueFailed: 'Încărcarea nu a putut porni. Reîncarcă pagina și încearcă din nou.',
};

/** "Unde ajunge fișierul": the live policy of the chosen category. */
const policy = {
  title: 'Unde ajunge fișierul',
  storage: 'Storage',
  storageValue: (primary: string, fallback: string | null) => (fallback ? `${primary} (rezervă: ${fallback})` : primary),
  policy: 'Politică',
  policyValue: (name: string, version: number) => `${name} · v${version}`,
  parts: 'Bucăți',
  partsValue: (size: string, parallel: number) => `${size} · ${parallel} în paralel`,
  encryption: 'Criptare',
  encrypted: (algorithm: string | null) => (algorithm ? `Da · ${algorithm}` : 'Da'),
  notEncrypted: 'Nu',
  maxSize: 'Dimensiune maximă',
  types: 'Tipuri acceptate',
  frozen: 'Politica e fixată la pornirea încărcării: o modificare ulterioară nu afectează transferul în curs.',
  loading: 'Se încarcă politica…',
  unavailable: 'Politica nu a putut fi încărcată. Limitele ei se verifică oricum la pornirea încărcării.',
  tile: (storage: string, chunk: string, encrypted: boolean) => `${storage} · ${chunk} · criptat: ${encrypted ? 'da' : 'nu'}`,
};

/** "Ce se întâmplă dacă pică rețeaua" (beat 2 narration). */
const network = {
  title: 'Ce se întâmplă dacă pică rețeaua',
  steps: [
    'Ne oprim singuri și reîncercăm cu pauze tot mai lungi.',
    'Revenim fără niciun clic când rețeaua funcționează din nou.',
    'După reîncărcarea paginii continuăm de la ultima bucată confirmată.',
    'La final comparăm amprenta calculată aici cu cea de pe server.',
  ],
};

const seconds = (n: number) => count(n, { one: 'o secundă', few: '# secunde', other: '# de secunde' });

/** The upload queue on the Încărcare screen (rows, states and actions). */
const queue = {
  title: 'Coada de încărcare',
  summary: (total: number, active: number) => `${files(total)} · ${active} în curs`,
  empty: 'Niciun fișier în coadă. Fișierele alese apar aici, iar încărcarea continuă și dacă schimbi pagina.',
  hashingNote: 'Calculăm amprenta SHA-256 aici, bucată cu bucată, fără să citim tot fișierul în memorie. Încărcarea pornește imediat după.',
  hashingValue: 'Se calculează amprenta',
  partsConfirmed: (done: number, total: number) => `${formatInt(done)} din ${formatInt(total)} bucăți confirmate`,
  speed: (perSecond: string) => `${perSecond}/s`,
  left: (time: string) => `${time} rămase`,
  retryIn: (s: number) => `reîncercare în ${s}\u00A0s`,
  retrySpoken: (s: number) => `conexiune pierdută, reîncercare automată în ${seconds(s)}`,
  offlineWait: 'reluăm automat când revine rețeaua',
  offlineSpoken: 'conexiune pierdută, reluăm automat când revine rețeaua',
  pausedFor: { user: 'oprită de tine', offline: 'fără rețea', session: 'sesiunea a expirat', logout: 'te-ai deconectat' },
  needsFileReopen: 'Pagina a fost reîncărcată. Un clic redeschide fișierul; verificăm că este același și continuăm de unde am rămas.',
  needsFileReselect: 'Pagina a fost reîncărcată. Alege din nou același fișier; verificăm că este identic și continuăm de la ultima bucată confirmată.',
  clientHash: 'Amprentă SHA-256 (client):',
  bothHashes: 'Client = server:',
  startedAs: 'Pornit ca',
  policyAtStart: (version: number) => `Politica v${version} (la pornire)`,
  availableIn: (time: string) => `Disponibil pentru dispecerat în ${time}`,
  fallback: (storage: string) => `Scris pe rezervă: ${storage}`,
  storedOn: (storage: string) => `Stocat pe ${storage}`,
  openFile: 'Deschide fișierul',
  traceId: 'ID urmărire',
  actions: {
    pause: 'Pauză',
    resume: 'Continuă',
    retry: 'Reia',
    reopen: 'Continuă încărcarea',
    reselect: 'Alege din nou fișierul',
    cancel: 'Anulează',
    dismiss: 'Ascunde',
  },
  cancelTitle: 'Anulezi încărcarea',
  cancelBody: 'Bucățile trimise până acum se șterg de pe server, iar încărcarea nu mai poate fi reluată.',
  cancelKeep: 'Nu, continuă',
  cancelConfirm: 'Da, anulează',
};

/** Upload screen, tray and engine copy (slice 6b). */
export const upload = {
  stateLabel,
  failure,
  /** Row label of a connection document before the server names it: never the file name (personal data). */
  connectionLabel: (requestNumber: string) => `Document racordare nr. ${requestNumber}`,
  form,
  categories,
  storages,
  screen,
  policy,
  network,
  queue,
  tray: {
    storageUnavailable: (storage: string) => `${storage} nu este disponibil. Celelalte categorii funcționează normal. Reîncercăm automat.`,
  },
  /** Name of a progress bar that has no file name next to it. */
  progressLabel: 'Progresul încărcării',
  dropzone: { title: 'Trage fișierele aici', orPick: 'sau alege-le de pe dispozitiv', choose: 'Alege fișiere' },
  /** Chunk-grid cells. */
  legend: { done: 'Confirmată de server', flight: 'În transfer', failed: 'Se reîncearcă', pending: 'În așteptare' },
  validation: {
    empty: 'Fișierul este gol.',
    tooLarge: (limit: string) => `Fișierul depășește ${limit}, limita politicii.`,
    typeNotAllowed: (mime: string) => `Tipul ${mime} nu este permis pentru această categorie.`,
  },
} as const;
