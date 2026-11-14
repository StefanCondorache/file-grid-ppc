export const session = {
  warnTitle: 'Sesiunea expiră în curând',
  warnBody: (mmss: string) => `Sesiunea expiră în ${mmss}. Încărcările în curs se opresc și continuă după ce intri din nou.`,
  stay: 'Rămân conectat',
  logout: 'Deconectare',
} as const;
