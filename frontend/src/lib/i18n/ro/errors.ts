export const errors = {
  generic: 'A apărut o eroare.',
  traceId: 'ID urmărire',
  NETWORK: 'Nu ne putem conecta la server. Verifică rețeaua; reîncercăm automat.',
  UNAUTHENTICATED: 'Sesiunea a expirat. Intră din nou în cont.',
  INVALID_CREDENTIALS: 'Rol sau parolă greșită.',
  FORBIDDEN: 'Nu ai acces la această acțiune.',
  NOT_FOUND: 'Nu am găsit ce cauți.',
  VALIDATION_ERROR: 'Unele câmpuri nu sunt completate corect.',
  RATE_LIMITED: 'Prea multe cereri. Încearcă din nou peste câteva secunde.',
  STORAGE_UNAVAILABLE: 'Storage-ul nu este disponibil. Celelalte categorii funcționează normal.',
  FILE_CORRUPT: 'Fișier corupt detectat.',
} as const;
