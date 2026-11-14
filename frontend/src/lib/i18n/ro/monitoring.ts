/** Business guarantees, alerts, storage health and observability (slice 6e). Numbers arrive pre-formatted. */
export const monitoring = {
  boardTitle: 'Cele 4 garanții, acum',
  boardLead: 'Calculate de server din jurnalul operațiilor și actualizate live.',
  boardEmpty: 'Serverul nu a trimis încă starea garanțiilor.',
  categories: {
    meter_readings: 'Citiri contoare',
    fault_records: 'Avarii',
    connection_documents: 'Racordări',
    drone_videos: 'Video dronă',
  },
  states: { ok: 'OK', at_risk: 'În pericol', violated: 'Încălcat' },
  /** Announcer message when a guarantee changes state (accessibility.md §4). */
  stateChanged: (guarantee: string, state: string) => `Garanția ${guarantee}: ${state}`,
  counters: {
    received: 'primite',
    unique: 'unice',
    duplicatesRejected: 'duplicate respinse',
    lost: 'pierdute (trebuie 0)',
    unknown: 'necunoscut',
  },
  fault: {
    kpi: 'Până la dispecerat · p95',
    target: (s: string) => `țintă ≤ ${s}`,
    noSamples: 'fără avarii recente',
  },
  connection: {
    kpi: 'Criptate în repaus',
    target: (pct: string) => `trebuie ${pct}`,
    reveals: { one: '# dezvăluire azi', few: '# dezvăluiri azi', other: '# de dezvăluiri azi' },
    revealLimit: (max: string) => `limită ${max}`,
    lastCheck: (time: string) => `ultima verificare ${time}`,
  },
  drone: {
    kpi: 'Transferuri reușite',
    target: (pct: string) => `țintă ≥ ${pct}`,
    noTransfers: 'niciun transfer încheiat recent',
    completed: (n: string) => `${n} finalizate`,
    resumed: (n: string) => `${n} reluate automat`,
    failed: (n: string) => `${n} eșuate`,
  },
  /** The plain-Romanian sentence of each card (sentences.ts picks one from the state and cause code). */
  sentences: {
    faultTime: (p95: string, relation: 'above' | 'near' | 'below', target: string) =>
      `Avariile ajung la dispecerat în ${p95}, ${{ above: 'peste', near: 'aproape de', below: 'sub' }[relation]} ținta de ${target}.`,
    faultNoSamples: (target: string) => `Nicio avarie încărcată recent; ținta este de ${target} până la dispecerat.`,
    meterOk: 'Nicio citire pierdută sau dublată.',
    meterLostForms: { one: '# citire pierdută', few: '# citiri pierdute', other: '# de citiri pierdute' },
    meterLost: (lost: string, max: string) => `${lost}; trebuie să fie ${max}.`,
    meterUnknown: 'Simulatorul nu răspunde: nu putem confirma că nu s-a pierdut nicio citire.',
    connectionOk: 'Datele personale sunt criptate și fiecare acces este auditat.',
    connectionNotEncrypted: (pct: string, min: string) => `Doar ${pct} din documentele de racordare sunt criptate; ținta este ${min}.`,
    connectionTimesForms: { one: '# dată', few: '# ori', other: '# de ori' },
    connectionUnmaskSpike: (times: string, max: string) => `Datele personale au fost afișate de ${times} azi, peste limita de ${max}.`,
    droneOk: 'Transferurile mari se termină și pe rețea instabilă.',
    droneBelow: (rate: string, min: string) => `Doar ${rate} din transferurile video s-au încheiat cu succes, sub ținta de ${min}.`,
    droneNear: (rate: string, min: string) => `${rate} din transferurile video s-au încheiat cu succes, aproape de pragul minim de ${min}.`,
    fallback: { ok: 'Garanția este respectată.', at_risk: 'Garanția este în pericol.', violated: 'Garanția este încălcată.' },
  },
} as const;
