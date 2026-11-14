import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Role } from '../common/domain';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../database/database';
import { hashPassword, verifyPassword } from './password';

interface SeedAccount {
  readonly username: string;
  readonly displayName: string;
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
          display_name: account.displayName,
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

/** One demo account per role for the login page's role dropdown (ADR-0022); username = role id. */
export const DEMO_ACCOUNTS: readonly { username: Role; displayName: string }[] = [
  { username: 'teren', displayName: 'Echipă de teren' },
  { username: 'dispecerat', displayName: 'Dispecerat' },
  { username: 'racordari', displayName: 'Angajat racordări' },
  { username: 'auditor', displayName: 'Auditor' },
];

export async function ensureSeedUsers(db: Db, config: AppConfig): Promise<void> {
  await ensureUser(db, {
    username: config.adminUsername,
    displayName: 'Administrator',
    password: config.adminPassword,
    role: 'admin',
  });
  if (!config.demoMode) {
    // Demo mode off: the demo accounts must not be able to log in.
    for (const account of DEMO_ACCOUNTS) {
      await db
        .deleteFrom('users')
        .where('username', '=', account.username)
        .where('role', '=', account.username)
        .execute();
    }
    return;
  }
  for (const account of DEMO_ACCOUNTS) {
    await ensureUser(db, {
      username: account.username,
      displayName: account.displayName,
      password: config.demoUsersPassword,
      role: account.username,
    });
  }
}

/**
 * Creates the admin account (ADMIN_USERNAME/ADMIN_PASSWORD) and, in demo mode, one account per role and re-syncs their passwords.
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
