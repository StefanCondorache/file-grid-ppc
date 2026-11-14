/** Download and re-verification (FE-04, Task 6c.8). */
export const integrity = {
  download: 'Descarcă',
  downloadLabel: (name: string) => `Descarcă și verifică ${name}`,
  downloading: (pct: string) => `Se descarcă… ${pct}`,
  cancel: 'Anulează descărcarea',
  verifiedClient: 'Amprenta SHA-256 calculată în browser corespunde celei stocate.',
  verifiedServer: 'Fișier mare: verificarea a făcut-o serverul, nu browserul.',
  corruptBody: 'Amprenta SHA-256 nu corespunde. Fișierul nu a fost salvat.',
  hashes: 'Amprente SHA-256',
  expected: 'Așteptat',
  actual: 'Calculat',
  unknown: 'necunoscut',
  storage: 'Storage',
  trace: 'ID urmă',
  nextStep: 'Pas următor',
  next: {
    restore_from_backup: 'Restaurează din rezervă',
    notify_storage_team: 'Anunță echipa de storage',
  },
  failed: 'Descărcarea nu a reușit. Încercați din nou.',
  cancelled: 'Descărcare anulată.',
} as const;
