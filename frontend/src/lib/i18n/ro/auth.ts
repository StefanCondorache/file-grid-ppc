import type { Role } from '@/lib/api/types';

export const auth = {
  title: 'Intră în cont',
  welcome: 'Bun venit în FileGrid',
  welcomeBody: 'Fișierele de teren ale rețelei, într-un singur loc: încărcate sigur, verificate și ușor de găsit.',
  photoNote: 'Fotografie documentară (licențiată): tehnician în echipament de protecție într-o stație de transformare',
  roleLabel: 'Rol',
  passwordLabel: 'Parolă',
  submit: 'Intră în cont',
  submitting: 'Se verifică…',
  passwordRequired: 'Introdu parola.',
  expired: 'Sesiunea a expirat. Intră din nou în cont.',
  secureNote: 'Conexiune securizată (HTTPS). Fiecare autentificare apare în jurnalul de audit.',
  activeRole: (label: string) => `Rol activ: ${label}`,
  demoRole: 'ROL DEMO',
  logout: 'Deconectare',
  roles: {
    teren: { label: 'Echipă de teren', hint: 'încarcă video și avarii' },
    dispecerat: { label: 'Dispecerat', hint: 'avarii, contoare' },
    racordari: { label: 'Angajat racordări', hint: 'documente, date mascate' },
    auditor: { label: 'Auditor', hint: 'audit, statistici, dezvăluire' },
    admin: { label: 'Administrator', hint: 'politici, demo' },
  } satisfies Record<Role, { label: string; hint: string }>,
} as const;
