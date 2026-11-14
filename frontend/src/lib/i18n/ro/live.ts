export const live = {
  open: 'Live',
  connecting: 'Se conectează…',
  reconnecting: (s: number) => `Reconectare în ${s} s…`,
  offline: 'Fără conexiune',
  polling: 'Actualizare periodică',
  newFault: (zone: string, place: string) => `Avarie nouă: ${zone}, ${place}`,
  newFaults: (n: number) => `${n} avarii noi`,
  zones: { muntenia: 'Muntenia', banat: 'Banat', dobrogea: 'Dobrogea' } as Record<string, string>,
} as const;
