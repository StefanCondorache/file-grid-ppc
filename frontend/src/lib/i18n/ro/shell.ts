export const shell = {
  groups: { monitoring: 'Monitorizare', files: 'Fișiere', admin: 'Administrare', demo: 'Operațiuni' },
  nav: {
    guarantees: 'Garanții de business',
    meters: 'Contoare live',
    observability: 'Observabilitate',
    statistics: 'Statistici',
    upload: 'Încărcare',
    files: 'Fișiere',
    policies: 'Politici',
    audit: 'Jurnal de audit',
    demo: 'Cameră de control',
  },
  mainNav: 'Navigare principală',
  tagline: 'Fișiere de teren · Rețea',
  user: (name: string) => `Utilizator: ${name}`,
} as const;
