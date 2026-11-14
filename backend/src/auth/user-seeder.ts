import type { Role } from '../common/domain';
import type { AppConfig } from '../config/config';
import type { Db } from '../database/database';
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

/**
 * Creates the admin account (ADMIN_USERNAME/ADMIN_PASSWORD) and, in demo mode, one account per role,
 * and re-syncs their passwords. Run by the boot (src/lifecycle/boot.service.ts) once the database
 * is reachable and migrated.
 */
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
