import 'server-only';

import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

import { openDb } from '@/app/lib/db';
import { adoptActiveTeamMembership } from '@/app/lib/organization/team-membership';
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

async function countPostgresAuthUsers(): Promise<number> {
  const database = await openDb();
  try {
    return await getPostgresAuthUserCount(database);
  } finally {
    await database.close();
  }
}

export async function getAuthUserCount(): Promise<number> {
  return countPostgresAuthUsers();
}

export async function hasAnyAuthUser(): Promise<boolean> {
  return (await getAuthUserCount()) > 0;
}

async function createInitialOwnerPostgres(input: InitialOwnerInput): Promise<InitialOwner> {
  const { name, email, password } = input;
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

    const bootstrap = await ensurePostgresOrganizationBootstrapForUser(database, userId);
    if (!bootstrap.organizationId) {
      throw new InitialOwnerSetupError(
        'DATABASE_ERROR',
        'Could not create the initial owner membership.',
      );
    }
    await adoptActiveTeamMembership(database, {
      organizationId: bootstrap.organizationId,
      userId,
      role: 'owner',
      source: 'first_owner',
      actorUserId: userId,
      seatOperationType: 'reconcile',
      transactionMode: 'existing',
      now: Date.now(),
    });

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
  // Avoid password hashing on an already configured public setup endpoint.
  // The transaction below still performs the authoritative check for races.
  if (await getAuthUserCount() > 0) {
    throw new InitialOwnerSetupError('ALREADY_CONFIGURED', 'Initial setup is already complete.');
  }
  const validation = validateInitialOwnerInput(input);
  if (!validation.ok) {
    throw new InitialOwnerSetupError('INVALID_INPUT', validation.error, validation.field);
  }

  return createInitialOwnerPostgres(validation.value);
}
