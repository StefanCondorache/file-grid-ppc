import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Role } from '../common/domain';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../database/database';
import { hashPassword, verifyPassword } from './password';

interface SeedAccount {
  readonly username: string;
  readonly password: string;
  readonly role: Role;
}

async function ensureUser(db: Db, account: SeedAccount): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('users')
      .select(['id', 'password_hash', 'role'])
      .where('username', '=', account.username)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      // ON CONFLICT: replicas starting together may race to create the same account.
      await trx
        .insertInto('users')
        .values({
          username: account.username,
          password_hash: await hashPassword(account.password),
          role: account.role,
        })
        .onConflict((conflict) => conflict.column('username').doNothing())
        .execute();
      return;
    }
    const passwordChanged = !(await verifyPassword(existing.password_hash, account.password));
    const updates = {
      ...(existing.role !== account.role ? { role: account.role } : {}),
      ...(passwordChanged ? { password_hash: await hashPassword(account.password) } : {}),
    };
    if (Object.keys(updates).length > 0) {
      await trx.updateTable('users').set(updates).where('id', '=', existing.id).execute();
    }
  });
}

export async function ensureSeedUsers(db: Db, config: AppConfig): Promise<void> {
  const accounts: SeedAccount[] = [
    { username: config.adminUsername, password: config.adminPassword, role: 'admin' },
    ...(config.operatorPassword
      ? [
          {
            username: config.operatorUsername,
            password: config.operatorPassword,
            role: 'operator' as const,
          },
        ]
      : []),
  ];
  for (const account of accounts) {
    await ensureUser(db, account);
  }
}

/**
 * Creates the admin (and optional operator) account from the env and re-syncs their passwords.
 * The container runs migrations first, so the DB was just reachable; if it is not now, keep
 * serving (/readyz reports it) instead of crash-looping.
 */
@Injectable()
export class UserSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(UserSeeder.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await ensureSeedUsers(this.db, this.config);
    } catch (error) {
      this.logger.error({
        message: 'could not seed users from the environment',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
