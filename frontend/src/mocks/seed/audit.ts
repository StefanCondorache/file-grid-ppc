import type { AuditRow } from '@/features/audit/types';
import type { UserRef } from '@/lib/api/types';
import { SEED_USERS } from './auth';

const user = (username: string): UserRef => SEED_USERS.find((u) => u.username === username)!;

/** A connection document (personal data); its display name never carries the applicant's name. */
export const SEED_CONNECTION_FILE = { id: 'f-con-0412', name: 'Cerere racordare RC-2026-0412.pdf' } as const;
const CON = { fileId: SEED_CONNECTION_FILE.id, fileDisplayName: SEED_CONNECTION_FILE.name, category: 'connection' as const };

const row = (id: string, at: string, actor: string, rest: Partial<AuditRow> & Pick<AuditRow, 'action' | 'traceId'>): AuditRow => ({
  id, at, actor: user(actor), actingAs: null, demo: false, outcome: 'success', category: null, fileId: null,
  fileDisplayName: null, reason: null, details: null, clientIp: '10.20.4.17', ...rest,
});

/** Baseline audit history for the demo (beat 4); live events from the mock handlers are added on top. */
export const AUDIT_SEED: AuditRow[] = [
  row('a-seed-12', '2026-11-14T09:33:10+02:00', 'admin', { action: 'download', ...CON, actingAs: 'auditor', demo: true, traceId: '4bf92f3577b34da6a3ce929d0e0e4736' }),
  row('a-seed-11', '2026-11-14T09:32:41+02:00', 'admin', { action: 'reveal_pii', ...CON, actingAs: 'auditor', demo: true, reason: 'Demonstrație: verificare dosar racordare', traceId: '0af7651916cd43dd8448eb211c80319c' }),
  row('a-seed-10', '2026-11-14T09:30:02+02:00', 'admin', { action: 'role_switch', actingAs: 'auditor', demo: true, details: 'admin → auditor', traceId: 'b7ad6b7169203331a9f1c2d4e5f60718' }),
  row('a-seed-09', '2026-11-14T08:14:55+02:00', 'auditor', { action: 'reveal_pii', ...CON, reason: 'Contestație client, dosar 1187', clientIp: '10.20.8.41', traceId: '5c2e1f0a9b8d47c6a3e2f1d0c9b8a706' }),
  row('a-seed-08', '2026-11-14T08:12:20+02:00', 'auditor', { action: 'download', ...CON, clientIp: '10.20.8.41', traceId: '8e7d6c5b4a3948271605f4e3d2c1b0a9' }),
  row('a-seed-07', '2026-11-14T08:05:03+02:00', 'auditor', { action: 'login', clientIp: '10.20.8.41', traceId: '1a2b3c4d5e6f47089a1b2c3d4e5f6071' }),
  row('a-seed-06', '2026-11-13T16:40:18+02:00', 'admin', { action: 'policy_update', category: 'fault', details: 'chunkSize 8 MiB → 16 MiB, versiunea 3 → 4', traceId: 'c0ffee00ba5e4d1e9a8b7c6d5e4f3a21' }),
  row('a-seed-05', '2026-11-13T15:02:37+02:00', 'racordari', { action: 'reveal_pii', ...CON, outcome: 'denied', clientIp: '10.20.6.12', traceId: 'd1e2f3a4b5c64d7e8f9a0b1c2d3e4f50' }),
  row('a-seed-04', '2026-11-13T15:00:09+02:00', 'racordari', { action: 'upload', ...CON, details: '2,4 MB, criptat AES-256-GCM', clientIp: '10.20.6.12', traceId: 'e5f6a7b8c9d04e1f2a3b4c5d6e7f8091' }),
  row('a-seed-03', '2026-11-13T11:20:44+02:00', 'dispecerat', { action: 'download', category: 'fault', fileId: 'f-flt-0098', fileDisplayName: 'Defect PT 0098 - foto.jpg', traceId: 'f9e8d7c6b5a44932817f6e5d4c3b2a10' }),
  row('a-seed-02', '2026-11-12T10:00:31+02:00', 'admin', { action: 'role_switch', actingAs: 'racordari', demo: true, details: 'admin → racordari', traceId: '2468ace013574b9d8f0e1d2c3b4a5968' }),
  row('a-seed-01', '2026-11-12T07:45:12+02:00', 'teren', { action: 'login', clientIp: '10.20.2.5', traceId: '13579bdf02464c8ea0b1c2d3e4f5a6b7' }),
];
