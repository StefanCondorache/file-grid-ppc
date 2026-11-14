import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import type { StorageName } from '../common/domain';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../database/database';
import { FilesService } from '../files/files.service';
import { SimulatorClient } from '../meters/simulator.client';
import { ObjectStoreService } from '../object-store/object-store.service';
import { KubeClient } from './kube.client';

const MAX_CORRUPTION_READ = 64 * 1024 * 1024;

/** The jury's demo panel: storm, corrupt a file, stop/start a storage (all audited, demo mode only). */
@Injectable()
export class DemoService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly simulator: SimulatorClient,
    private readonly files: FilesService,
    private readonly store: ObjectStoreService,
    private readonly kube: KubeClient,
    private readonly audit: AuditService,
  ) {}

  async status() {
    const [simulator, storages] = await Promise.all([
      this.simulator.status().catch(() => null),
      Promise.resolve(this.store.status()),
    ]);
    return {
      demoMode: this.config.demoMode,
      simulator,
      storm:
        simulator?.mode === 'peak'
          ? { category: 'meter_readings', endsAt: simulator.stormEndsAt ?? null }
          : null,
      storages,
    };
  }

  async startStorm(principal: Principal, durationS: number) {
    const current = await this.simulator.status();
    if (current.mode === 'peak') {
      throw new AppError(409, 'STORM_ALREADY_RUNNING', 'O furtună rulează deja.');
    }
    const status = await this.simulator.update({ mode: 'peak', durationS });
    await this.record(
      principal,
      'storm_start',
      `meter_readings x${Math.round(status.peakRatePerS / Math.max(1, status.normalRatePerS))} ${durationS}s`,
    );
    return status;
  }

  async stopStorm(principal: Principal) {
    const status = await this.simulator.update({ mode: 'normal' });
    await this.record(principal, 'storm_stop', 'meter_readings');
    return status;
  }

  /** Flips one byte of the stored object in place; the next download or verification detects it. */
  async corrupt(principal: Principal, fileId: string) {
    const row = await this.files.visible(principal, fileId);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of this.store.readRaw(row.category, row.storage, row.storage_key)) {
      total += chunk.length;
      if (total > MAX_CORRUPTION_READ) {
        throw new AppError(422, 'FILE_TOO_LARGE', 'Pentru demo se corup doar fișiere sub 64 MiB.');
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length === 0) throw new AppError(422, 'VALIDATION_ERROR', 'Fișierul este gol.');
    const offset = Math.floor(bytes.length / 2);
    bytes[offset] = (bytes[offset] ?? 0) ^ 0xff;
    await this.store.overwriteRaw(row.category, row.storage, row.storage_key, bytes);
    await this.audit.record(this.db, {
      actor: principal.username,
      action: 'file_corrupted',
      outcome: 'success',
      demo: true,
      category: row.category,
      fileId: row.id,
      details: `demo: byte ${offset} flipped on ${row.storage}`,
    });
    return { fileId: row.id, storage: row.storage, corruptedAt: new Date().toISOString() };
  }

  async setStorage(principal: Principal, storage: StorageName, running: boolean) {
    if (storage === 'db') {
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'PostgreSQL ține și metadatele; opriți S3 sau FTP.',
      );
    }
    await this.kube.scale(storage, running ? 1 : 0);
    await this.record(principal, running ? 'storage_start' : 'storage_stop', storage);
    return { storage, running, replicas: running ? 1 : 0 };
  }

  private record(
    principal: Principal,
    action: 'storm_start' | 'storm_stop' | 'storage_stop' | 'storage_start',
    details: string,
  ) {
    return this.audit.record(this.db, {
      actor: principal.username,
      action,
      outcome: 'success',
      demo: true,
      details,
    });
  }
}
