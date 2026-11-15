# Demo script (7 minutes)

From PRD §6, adapted to the app as built. Logged in as `admin` at `https://ppc.filegrid.cc.cd` (demo mode,
passwordless login: pick the role). Run `npm run seed:demo` in `backend/` once after the final deploy.

Rehearse unattended with `frontend/tests/e2e/6h-rehearsal.spec.ts` (see the end); the backup video is the same
spec with `E2E_VIDEO=on`.

| Time | Beat | Click | Expect | Proves | If it fails live |
|---|---|---|---|---|---|
| 0:00 | 1 · Opening | Log in as Administrator | "Garanții de business": 4 guarantee cards, storage health strip, live meter counters | F2, N6, N8 | Play the backup video from 0:00 |
| 0:30 | 2 · Drone upload | Role → Echipă de teren · Încărcare · Video inspecție dronă · drop the video, fill line and zone · Încarcă · during the upload: DevTools → Offline, then Online, then F5 | Chunk grid; pauses offline, resumes by itself, survives the reload; SHA-256 "verificat" | N3, N12, F4 | Upload a small video; show the resume in the backup video |
| 1:45 | 3 · Fault record | Role → Dispecerat · Încărcare · Înregistrare de avarie · zone, substation, severity · Încarcă | Available within seconds; it appears in Fișiere without a refresh | fault guarantee, F1, F6 | Open Fișiere, filter by category |
| 2:30 | 4 · Connection document | Role → Angajat racordări · upload a request (name, CNP) · Role → Auditor · open it · Afișează datele personale (with a reason) · Jurnal de audit | Name and CNP masked, "criptat" storage; the reveal is in the audit trail with its reason | N9, connection guarantee | Show the masked detail, skip the reveal |
| 3:15 | 5 · Storm and S3 down | Role → Administrator · Cameră de control · Pornește furtuna · Oprește S3 · Observabilitate | Meter readings ×10 while the other categories stay flat; uploads that write to S3 go to the fallback; an alert, then recovery after Pornește S3 | N1, N11, N6 | Resetează demo-ul, then explain from the Observabilitate chart |
| 4:30 | 6 · Integrity and trace | Cameră de control · Corupe un fișier · Verifică integritatea · open the file · its trace | "Corupție detectată" with both hashes; trace api → policy → storage → audit, with durations | F4, N13, N5 | Open an older file's trace |
| 5:30 | 7 · Policy live | Politici · Înregistrări defecte · Modifică · primary FTP · Revizuiește modificările · Salvează · upload a fault record | "Salvat · versiunea vN"; the new file says "Stocat pe FTP · politica vN" | F3, F2 | Show the version history |
| 6:00 | 8 · Statistics | Statistici | S1 storage fit per category, S2 normal day vs the storm just run, S3 faults by zone, each with its interpretation | §5 | Read the interpretations aloud |

After the demo: Cameră de control · Resetează demo-ul, and set the fault records policy back to S3.

## Rehearsal and backup video

```
cd frontend
# on the mocks: every beat, the demo actions included; nothing leaves the laptop
E2E_BROWSER=/usr/bin/chromium npx playwright test tests/e2e/6h-rehearsal.spec.ts
# against the deployed stack: read-only beats and small test- uploads; demo actions only with E2E_DEMO_ACTIONS=1
E2E_BASE_URL=https://ppc.filegrid.cc.cd npx playwright test tests/e2e/6h-rehearsal.spec.ts
# backup video: a 1440x900 .webm per run, in E2E_OUTPUT_DIR
E2E_VIDEO=on E2E_OUTPUT_DIR=/tmp/filegrid-demo-video npx playwright test tests/e2e/6h-rehearsal.spec.ts
```

`E2E_DEMO_ACTIONS=1` on the deployed stack starts a real storm, stops S3, corrupts a file and changes a policy:
use it only in the team rehearsal, and reset afterwards.
