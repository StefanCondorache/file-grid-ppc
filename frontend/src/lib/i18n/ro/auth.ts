import type { Role } from '@/lib/api/types';

export const auth = {
  title: 'Intră în cont',
  welcome: 'Bun venit în FileGrid',
  roleLabel: 'Rol',
  passwordLabel: 'Parolă',
  submit: 'Intră în cont',
  submitting: 'Se verifică…',
  passwordRequired: 'Introdu parola.',
  passwordlessNote: 'Mod demo: autentificare fără parolă.',
  expired: 'Sesiunea a expirat. Intră din nou în cont.',
  secureNote: 'Fiecare autentificare apare în jurnalul de audit.',
  activeRole: (label: string) => `Rol activ: ${label}`,
  logout: 'Deconectare',
  roles: {
    teren: { label: 'Echipă de teren', hint: 'încarcă video și avarii' },
    dispecerat: { label: 'Dispecerat', hint: 'avarii, contoare' },
    racordari: { label: 'Angajat racordări', hint: 'documente, date mascate' },
    auditor: { label: 'Auditor', hint: 'audit, statistici, dezvăluire' },
    admin: { label: 'Administrator', hint: 'politici, demo' },
  } satisfies Record<Role, { label: string; hint: string }>,
} as const;
