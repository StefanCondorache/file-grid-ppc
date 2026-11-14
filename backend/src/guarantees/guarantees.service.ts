import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Category } from '../common/domain';
import { APP_CONFIG, type AppConfig, type GuaranteeThresholds } from '../config/config';
import { DB, type Db } from '../database/database';
import { MetersService } from '../meters/meters.service';

export type GuaranteeState = 'ok' | 'at_risk' | 'violated';
type Comparator = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';

export interface GuaranteeMetric {
  readonly key: string;
  /** Decimal string (timestamps ISO); null when there is no sample yet. */
  readonly value: string | null;
  readonly unit: string | null;
  readonly threshold: string | null;
  readonly comparator: Comparator | null;
}

export interface GuaranteeStatus {
  readonly category: Category;
  readonly state: GuaranteeState;
  readonly causeCode: string | null;
  /** The values behind causeCode, for the UI's Romanian sentence. */
  readonly causeFacts: Readonly<Record<string, unknown>>;
  readonly metrics: readonly GuaranteeMetric[];
  readonly updatedAt: string;
}

interface Verdict {
  readonly state: GuaranteeState;
  readonly causeCode: string | null;
  readonly causeFacts: Readonly<Record<string, unknown>>;
}

const OK: Verdict = { state: 'ok', causeCode: null, causeFacts: {} };

function metric(
  key: string,
  value: number | string | null,
  extra: { unit?: string; threshold?: number; comparator?: Comparator } = {},
): GuaranteeMetric {
  return {
    key,
    value: value === null ? null : String(value),
    unit: extra.unit ?? null,
    threshold: extra.threshold === undefined ? null : String(extra.threshold),
    comparator: extra.comparator ?? null,
  };
}

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/**
 * The four business guarantees of the brief, computed from the metadata database with the
 * thresholds from the environment (GUARANTEE_*; docs/api.md lists them and their defaults):
 * meter readings never lost, fault records available fast, connection documents always encrypted
 * (and unmasked rarely), drone transfers succeed.
 */
@Injectable()
export class GuaranteesService {
  private readonly limits: GuaranteeThresholds;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly meters: MetersService,
  ) {
    this.limits = config.guarantees;
  }

  async all(): Promise<GuaranteeStatus[]> {
    const updatedAt = new Date().toISOString();
    const results = await Promise.all([
      this.meterReadings(),
      this.faultRecords(),
      this.connectionDocuments(),
      this.droneVideos(),
    ]);
    return results.map((result) => ({ ...result, updatedAt }));
  }

  private since(): Date {
    return new Date(Date.now() - this.limits.windowMinutes * 60_000);
  }

  private async meterReadings() {
    const counters = await this.meters.liveCounters();
    const max = this.limits.meterLostMax;
    const verdict: Verdict =
      counters.lost === null
        ? { state: 'at_risk', causeCode: 'METER_LOSS_UNKNOWN', causeFacts: {} }
        : counters.lost > max
          ? {
              state: 'violated',
              causeCode: 'METER_READINGS_LOST',
              causeFacts: { lost: counters.lost, max },
            }
          : OK;
    return {
      category: 'meter_readings' as const,
      ...verdict,
      metrics: [
        metric('received', counters.received),
        metric('unique', counters.unique),
        metric('duplicatesRejected', counters.duplicatesRejected),
        metric('lost', counters.lost, { threshold: max, comparator: 'lte' }),
      ],
    };
  }

  private async faultRecords() {
    const row = await this.db
      .selectFrom('operations')
      .select([
        sql<number | null>`percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)`.as('p95'),
        (eb) => eb.fn.countAll<string>().as('samples'),
      ])
      .where('category', '=', 'fault_records')
      .where('operation', '=', 'upload.complete')
      .where('status', '=', 'ok')
      .where('started_at', '>=', this.since())
      .executeTakeFirstOrThrow();
    const p95 = row.p95 === null ? null : Math.round(Number(row.p95));
    const target = this.limits.faultP95Ms;
    const facts = {
      p95Ms: p95,
      targetMs: target,
      samples: Number(row.samples),
      windowMinutes: this.limits.windowMinutes,
    };
    const verdict: Verdict =
      p95 === null
        ? OK
        : p95 > target
          ? { state: 'violated', causeCode: 'FAULT_P95_ABOVE_TARGET', causeFacts: facts }
          : p95 > target * this.limits.atRiskRatio
            ? { state: 'at_risk', causeCode: 'FAULT_P95_NEAR_TARGET', causeFacts: facts }
            : OK;
    return {
      category: 'fault_records' as const,
      ...verdict,
      metrics: [
        metric('uploadToAvailableP95Ms', p95, { unit: 'ms', threshold: target, comparator: 'lte' }),
      ],
    };
  }

  private async connectionDocuments() {
    const [files, reveals] = await Promise.all([
      this.db
        .selectFrom('files')
        .select([
          (eb) => eb.fn.countAll<string>().as('total'),
          sql<string>`count(*) FILTER (WHERE encrypted)`.as('encrypted'),
          (eb) => eb.fn.max('last_verified_at').as('last_verified_at'),
        ])
        .where('category', '=', 'connection_documents')
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('audit_log')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('action', '=', 'reveal_pii')
        .where('outcome', '=', 'success')
        .where('at', '>=', sql<Date>`date_trunc('day', now())`)
        .executeTakeFirstOrThrow(),
    ]);
    const total = Number(files.total);
    const encrypted = Number(files.encrypted);
    const encryptedPct = total === 0 ? 100 : round((encrypted / total) * 100, 2);
    const unmasked = Number(reveals.n);
    const minPct = this.limits.connectionEncryptedPct;
    const maxUnmask = this.limits.connectionUnmaskMax;
    const verdict: Verdict =
      encryptedPct < minPct
        ? {
            state: 'violated',
            causeCode: 'CONNECTION_NOT_ENCRYPTED',
            causeFacts: { encryptedPct, unencrypted: total - encrypted, minPct },
          }
        : unmasked > maxUnmask
          ? {
              state: 'at_risk',
              causeCode: 'CONNECTION_UNMASK_SPIKE',
              causeFacts: { unmaskEventsToday: unmasked, max: maxUnmask },
            }
          : OK;
    const lastCheck = files.last_verified_at as Date | string | null;
    return {
      category: 'connection_documents' as const,
      ...verdict,
      metrics: [
        metric('encryptedPct', encryptedPct, { unit: '%', threshold: minPct, comparator: 'gte' }),
        metric('unmaskEventsToday', unmasked, { threshold: maxUnmask, comparator: 'lte' }),
        metric('lastAuditCheckAt', lastCheck === null ? null : new Date(lastCheck).toISOString()),
      ],
    };
  }

  private async droneVideos() {
    const row = await this.db
      .selectFrom('upload_sessions')
      .select([
        sql<string>`count(*) FILTER (WHERE status = 'completed')`.as('completed'),
        sql<string>`count(*) FILTER (WHERE status IN ('failed', 'expired'))`.as('failed'),
        sql<string>`count(*) FILTER (WHERE resume_count > 0 AND status IN ('completed', 'open', 'verifying'))`.as(
          'resumed',
        ),
      ])
      .where('category', '=', 'drone_videos')
      .where('updated_at', '>=', this.since())
      .executeTakeFirstOrThrow();
    const completed = Number(row.completed);
    const failed = Number(row.failed);
    const finished = completed + failed;
    const successRate = finished === 0 ? null : round(completed / finished, 4);
    const { droneSuccessMin: min, droneSuccessAtRisk: atRisk } = this.limits;
    const facts = { successRate, min, failed, completed, windowMinutes: this.limits.windowMinutes };
    const verdict: Verdict =
      successRate === null
        ? OK
        : successRate < min
          ? { state: 'violated', causeCode: 'DRONE_SUCCESS_BELOW_TARGET', causeFacts: facts }
          : successRate < atRisk
            ? { state: 'at_risk', causeCode: 'DRONE_SUCCESS_NEAR_TARGET', causeFacts: facts }
            : OK;
    return {
      category: 'drone_videos' as const,
      ...verdict,
      metrics: [
        metric('transfersCompleted', completed),
        metric('transfersResumed', Number(row.resumed)),
        metric('transfersFailed', failed),
        metric('successRate', successRate, { threshold: min, comparator: 'gte' }),
      ],
    };
  }
}
