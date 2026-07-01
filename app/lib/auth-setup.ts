import 'server-only';

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

import { runMigrations } from '@/app/lib/db/migrate';
import { openDb } from '@/app/lib/db';
import {
  getDatabaseProviderProblemMessages,
  getDatabaseProvider,
  resolveDatabaseProviderGate,
  resolveSqlitePath,
} from '@/app/lib/db/provider';
import {
  areTeamFeaturesEnabled,
  ensureOrganizationBootstrapForUser,
  getDeploymentMode,
} from '@/app/lib/organization/bootstrap';
import {
  ensurePostgresCredentialPassword,
  ensurePostgresOrganizationBootstrapForUser,
  getPostgresAuthUserCount,
  insertPostgresAuthUser,
} from '@/app/lib/workspaces/postgres-runtime';

export const SETUP_PASSWORD_MIN_LENGTH = 8;
export const SETUP_PASSWORD_MAX_LENGTH = 128;

export type InitialOwnerInput = {
  name: string;
  email: string;
  password: string;
};

export type InitialOwner = {
  id: string;
  name: string;
  email: string;
};

type ValidationResult =
  | { ok: true; value: InitialOwnerInput }
  | { ok: false; error: string; field?: keyof InitialOwnerInput };

export class InitialOwnerSetupError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'ALREADY_CONFIGURED'
      | 'DATABASE_PROVIDER_BLOCKED'
      | 'DATABASE_ERROR',
    message: string,
    public readonly field?: keyof InitialOwnerInput,
  ) {
    super(message);
    this.name = 'InitialOwnerSetupError';
  }
}

function getSqlitePath(): string {
  return resolveSqlitePath();
}

function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function normalizeName(name: unknown): string {
  return typeof name === 'string' ? name.trim() : '';
}

function isValidEmail(email: string): boolean {
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateInitialOwnerInput(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Invalid setup payload.' };
  }

  const payload = input as Partial<Record<keyof InitialOwnerInput, unknown>>;
  const name = normalizeName(payload.name);
  const email = normalizeEmail(payload.email);
  const password = typeof payload.password === 'string' ? payload.password : '';

  if (!name || name.length > 100) {
    return { ok: false, field: 'name', error: 'Name must be between 1 and 100 characters.' };
  }

  if (!isValidEmail(email)) {
    return { ok: false, field: 'email', error: 'Enter a valid email address.' };
  }

  if (password.length < SETUP_PASSWORD_MIN_LENGTH || password.length > SETUP_PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      field: 'password',
      error: `Password must be between ${SETUP_PASSWORD_MIN_LENGTH} and ${SETUP_PASSWORD_MAX_LENGTH} characters.`,
    };
  }

  return { ok: true, value: { name, email, password } };
}

function openSetupDatabase() {
  const sqlitePath = getSqlitePath();
  mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = new Database(sqlitePath);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  runMigrations(sqlite);
  return sqlite;
}

function assertSetupDatabaseProviderAllowed(): void {
  const deploymentMode = getDeploymentMode();
  const gate = resolveDatabaseProviderGate({
    teamFeaturesEnabled: areTeamFeaturesEnabled(deploymentMode),
  });

  if (!gate.ok) {
    throw new InitialOwnerSetupError(
      'DATABASE_PROVIDER_BLOCKED',
      getDatabaseProviderProblemMessages(gate.blockers).join(' '),
    );
  }
}

function countUsers(sqlite: Database.Database): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS count FROM user').get() as { count?: number } | undefined;
  return Number(row?.count || 0);
}

async function countPostgresAuthUsers(): Promise<number> {
  const database = await openDb();
  try {
    return await getPostgresAuthUserCount(database);
  } finally {
    await database.close();
  }
}

export async function getAuthUserCount(): Promise<number> {
  if (getDatabaseProvider() === 'postgres') {
    return countPostgresAuthUsers();
  }

  const sqlite = openSetupDatabase();
  try {
    return countUsers(sqlite);
  } finally {
    sqlite.close();
  }
}

export async function hasAnyAuthUser(): Promise<boolean> {
  return (await getAuthUserCount()) > 0;
}

async function createInitialOwnerPostgres(input: InitialOwnerInput): Promise<InitialOwner> {
  const { name, email, password } = input;
  assertSetupDatabaseProviderAllowed();
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const accountId = randomUUID();
  const database = await openDb();

  try {
    await database.run('BEGIN');

    if (await getPostgresAuthUserCount(database) > 0) {
      await database.run('ROLLBACK');
      throw new InitialOwnerSetupError('ALREADY_CONFIGURED', 'Initial setup is already complete.');
    }

    await insertPostgresAuthUser(database, { userId, name, email });
    await ensurePostgresCredentialPassword(database, { userId, passwordHash, accountId });

    await ensurePostgresOrganizationBootstrapForUser(database, userId);

    await database.run('COMMIT');
    return { id: userId, name, email };
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Ignore rollback errors after a handled rollback.
    }
    if (error instanceof InitialOwnerSetupError) {
      throw error;
    }
    throw new InitialOwnerSetupError('DATABASE_ERROR', 'Could not create initial owner.');
  } finally {
    await database.close();
  }
}

export async function createInitialOwner(input: unknown): Promise<InitialOwner> {
  const validation = validateInitialOwnerInput(input);
  if (!validation.ok) {
    throw new InitialOwnerSetupError('INVALID_INPUT', validation.error, validation.field);
  }

  const { name, email, password } = validation.value;
  if (getDatabaseProvider() === 'postgres') {
    return createInitialOwnerPostgres({ name, email, password });
  }

  assertSetupDatabaseProviderAllowed();
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const accountId = randomUUID();
  const now = Date.now();
  const sqlite = openSetupDatabase();

  try {
    sqlite.exec('BEGIN IMMEDIATE');

    if (countUsers(sqlite) > 0) {
      sqlite.exec('ROLLBACK');
      throw new InitialOwnerSetupError('ALREADY_CONFIGURED', 'Initial setup is already complete.');
    }

    sqlite.prepare(`
      INSERT INTO user (
        id, name, email, email_verified, image, role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, name, email, 1, null, 'admin', now, now);

    sqlite.prepare(`
      INSERT INTO account (
        id, account_id, provider_id, user_id, password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(accountId, userId, 'credential', userId, passwordHash, now, now);

    ensureOrganizationBootstrapForUser(sqlite, userId);

    sqlite.exec('COMMIT');
    return { id: userId, name, email };
  } catch (error) {
    if (sqlite.inTransaction) {
      sqlite.exec('ROLLBACK');
    }
    if (error instanceof InitialOwnerSetupError) {
      throw error;
    }
    throw new InitialOwnerSetupError('DATABASE_ERROR', 'Could not create initial owner.');
  } finally {
    sqlite.close();
  }
}
