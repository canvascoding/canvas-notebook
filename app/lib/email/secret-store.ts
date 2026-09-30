import 'server-only';

import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

import { mutateScopedEnvEntries, readScopedEnvState } from '@/app/lib/integrations/env-config';
import { resolveSecretsDir, resolveUserSecretsDir } from '@/app/lib/runtime-data-paths';
import { mutateUnifiedSecretValue, readUnifiedSecretValue } from '@/app/lib/secrets/unified-env-store';

const ENCRYPTED_PREFIX = 'enc:v1';
const FALLBACK_KEY = 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY';

export type EmailAccountOAuthSecret = {
  authType: 'oauth';
  tokenType: string;
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresAt?: string;
};

export type EmailAccountSmtpSecret = {
  authType: 'smtp_imap';
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
  };
  imap?: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
  };
};

export type EmailAccountSecret = EmailAccountOAuthSecret | EmailAccountSmtpSecret;

function safePathSegment(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value) || value === '.' || value === '..') {
    throw new Error('Invalid email account secret reference segment.');
  }
  return value;
}

function legacySecretRoot(): string {
  return path.join(resolveSecretsDir(), 'email-accounts');
}

export function emailAccountSecretRef(userId: string, accountId: string): string {
  const owner = safePathSegment(userId);
  if (owner === 'workspace') throw new Error('The workspace secret namespace is reserved.');
  return `${owner}/${safePathSegment(accountId)}.json.enc`;
}

/**
 * Workspace mailboxes are configured by an instance administrator, but their
 * credentials belong to the shared workspace resource rather than that user.
 * Keep them in the instance secret scope instead of a user's private folder.
 */
export function workspaceEmailAccountSecretRef(accountId: string): string {
  return `workspace/${safePathSegment(accountId)}.json.enc`;
}

function secretRefSegments(secretRef: string): string[] {
  if (typeof secretRef !== 'string' || secretRef.length > 512 || secretRef.includes('\\')) {
    throw new Error('Invalid email account secret reference.');
  }
  const segments = secretRef.split('/');
  if (segments.length !== 2 || segments.some(segment => !segment)) {
    throw new Error('Invalid email account secret reference.');
  }
  for (const segment of segments) safePathSegment(segment);
  if (!segments[1].endsWith('.json.enc') || segments[1] === '.json.enc') {
    throw new Error('Invalid email account secret reference.');
  }
  return segments;
}

function userIdFromSecretRef(secretRef: string): string | null {
  const [userId] = secretRefSegments(secretRef);
  return userId && userId !== 'workspace' ? userId : null;
}

function storageScopeForSecretRef(secretRef: string) {
  const userId = userIdFromSecretRef(secretRef);
  return userId ? { userId } : { secretScope: 'system' as const };
}

function credentialKeyForSecretRef(secretRef: string): string {
  secretRefSegments(secretRef);
  return `CANVAS_CREDENTIAL_EMAIL_${crypto.createHash('sha256').update(secretRef, 'utf8').digest('hex').toUpperCase()}`;
}

function scopedSecretRoot(secretRef: string): string {
  const userId = userIdFromSecretRef(secretRef);
  return userId
    ? path.join(resolveUserSecretsDir(userId), 'email-accounts')
    : legacySecretRoot();
}

function secretPath(secretRef: string): string {
  const normalized = secretRef.split('/').map(safePathSegment).join('/');
  const userId = userIdFromSecretRef(secretRef);
  if (!userId) return path.join(legacySecretRoot(), normalized);
  const [, ...rest] = secretRefSegments(secretRef);
  return path.join(scopedSecretRoot(secretRef), rest.join('/') || `${safePathSegment(secretRef)}.json.enc`);
}

function legacySecretPath(secretRef: string): string {
  const normalized = secretRef.split('/').map(safePathSegment).join('/');
  return path.join(legacySecretRoot(), normalized);
}

function deriveEncryptionKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

async function readMasterSecretFromScope(userId: string | null, createIfMissing: boolean): Promise<string | null> {
  const configured = process.env.INTEGRATIONS_ENV_MASTER_KEY?.trim();
  if (configured) return configured;

  const storageScope = userId ? { userId } : { secretScope: 'system' as const };
  const state = await readScopedEnvState('integrations', storageScope);
  const existing = state.entries.find((entry) => entry.key === FALLBACK_KEY)?.value.trim();
  if (existing && !existing.startsWith(`${ENCRYPTED_PREFIX}:`)) return existing;
  if (existing) throw new Error('Email account secret encryption key is malformed.');
  if (!createIfMissing) return null;

  let generated = crypto.randomBytes(32).toString('base64url');
  const updated = await mutateScopedEnvEntries('integrations', (entries) => {
    const current = entries.find((entry) => entry.key === FALLBACK_KEY)?.value.trim();
    if (current && current.startsWith(`${ENCRYPTED_PREFIX}:`)) {
      throw new Error('Email account secret encryption key is malformed.');
    }
    if (current) {
      generated = current;
      return entries;
    }
    return [...entries, { key: FALLBACK_KEY, value: generated }];
  }, storageScope);
  return updated.entries.find((entry) => entry.key === FALLBACK_KEY)?.value.trim() || generated;
}

async function getMasterSecretForRef(secretRef: string): Promise<string> {
  const userId = userIdFromSecretRef(secretRef);
  const secret = await readMasterSecretFromScope(userId, true);
  if (!secret) throw new Error('Unable to initialize email account secret encryption key.');
  return secret;
}

async function encryptPayload(secretRef: string, payload: EmailAccountSecret): Promise<string> {
  const secret = await getMasterSecretForRef(secretRef);
  const iv = crypto.randomBytes(12);
  const key = deriveEncryptionKey(secret);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function parseEmailAccountSecret(value: unknown): EmailAccountSecret {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid email account secret payload.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.authType === 'oauth') {
    if (typeof candidate.tokenType !== 'string' || !candidate.tokenType.trim()
      || typeof candidate.accessToken !== 'string' || !candidate.accessToken.trim()
      || (candidate.refreshToken !== undefined && typeof candidate.refreshToken !== 'string')
      || (candidate.scope !== undefined && typeof candidate.scope !== 'string')
      || (candidate.expiresAt !== undefined && (typeof candidate.expiresAt !== 'string' || !Number.isFinite(Date.parse(candidate.expiresAt))))) {
      throw new Error('Invalid OAuth email account secret payload.');
    }
    return {
      authType: 'oauth',
      tokenType: candidate.tokenType,
      accessToken: candidate.accessToken,
      ...(candidate.refreshToken !== undefined ? { refreshToken: candidate.refreshToken } : {}),
      ...(candidate.scope !== undefined ? { scope: candidate.scope } : {}),
      ...(candidate.expiresAt !== undefined ? { expiresAt: candidate.expiresAt } : {}),
    };
  }
  if (candidate.authType !== 'smtp_imap') throw new Error('Invalid email account secret auth type.');
  const parseServer = (input: unknown, label: string): EmailAccountSmtpSecret['smtp'] => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Invalid ${label} email account secret settings.`);
    const server = input as Record<string, unknown>;
    if (typeof server.host !== 'string' || !server.host.trim()
      || typeof server.port !== 'number' || !Number.isInteger(server.port) || server.port < 1 || server.port > 65_535
      || typeof server.secure !== 'boolean'
      || typeof server.username !== 'string'
      || typeof server.password !== 'string') {
      throw new Error(`Invalid ${label} email account secret settings.`);
    }
    return { host: server.host, port: server.port, secure: server.secure, username: server.username, password: server.password };
  };
  const smtp = parseServer(candidate.smtp, 'SMTP');
  const imap = candidate.imap === undefined ? undefined : parseServer(candidate.imap, 'IMAP');
  return { authType: 'smtp_imap', smtp, ...(imap ? { imap } : {}) };
}

function decryptPayloadWithSecret(value: string, secret: string): EmailAccountSecret {
  const parts = value.split(':');
  if (parts.length !== 5) throw new Error('Invalid email account secret format.');
  const [, version, ivHex, tagHex, encryptedHex] = parts;
  if (version !== 'v1') throw new Error(`Unsupported email account secret version: ${version}`);

  const key = deriveEncryptionKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]);
  return parseEmailAccountSecret(JSON.parse(plain.toString('utf8')));
}

async function decryptPayload(secretRef: string, value: string): Promise<EmailAccountSecret> {
  if (!value.startsWith(`${ENCRYPTED_PREFIX}:`)) {
    return parseEmailAccountSecret(JSON.parse(value));
  }

  const userId = userIdFromSecretRef(secretRef);
  const candidates = (
    await Promise.all([
      readMasterSecretFromScope(userId, false),
      readMasterSecretFromScope(null, false),
    ])
  ).filter((entry): entry is string => Boolean(entry));

  let lastError: unknown = null;
  for (const secret of candidates) {
    try {
      return decryptPayloadWithSecret(value, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unable to decrypt email account secret.');
}

async function readLegacySecretValue(secretRef: string): Promise<string | null> {
  const primaryPath = secretPath(secretRef);
  const legacyPath = legacySecretPath(secretRef);
  try {
    return await fs.readFile(primaryPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (primaryPath === legacyPath) return null;
  }
  try {
    return await fs.readFile(legacyPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function mutateEmailAccountSecret<T>(
  secretRef: string,
  operation: (secret: EmailAccountSecret | null) => Promise<{ secret: EmailAccountSecret | null; result: T }>,
): Promise<T> {
  const key = credentialKeyForSecretRef(secretRef);
  const storageScope = storageScopeForSecretRef(secretRef);
  let result!: T;
  await mutateUnifiedSecretValue(key, async (stored) => {
    const fromLegacyFile = stored === null;
    const original = fromLegacyFile ? await readLegacySecretValue(secretRef) : stored;
    const deleted = original === 'null';
    const currentSecret = original === null || deleted ? null : await decryptPayload(secretRef, original);
    const outcome = await operation(currentSecret);
    result = outcome.result;
    if (outcome.secret === null) return null;

    const nextSecret = parseEmailAccountSecret(outcome.secret);
    if (currentSecret && JSON.stringify(currentSecret) === JSON.stringify(nextSecret)) {
      if (original && original.startsWith(`${ENCRYPTED_PREFIX}:`)) return original;
      if (!fromLegacyFile) return original;
    }
    return encryptPayload(secretRef, nextSecret);
  }, storageScope);
  return result;
}

export async function writeEmailAccountSecret(secretRef: string, payload: EmailAccountSecret): Promise<void> {
  const validated = parseEmailAccountSecret(payload);
  await mutateEmailAccountSecret(secretRef, async () => ({ secret: validated, result: undefined }));
}

export async function readEmailAccountSecret(secretRef: string): Promise<EmailAccountSecret> {
  const key = credentialKeyForSecretRef(secretRef);
  const stored = readUnifiedSecretValue(key, storageScopeForSecretRef(secretRef));
  if (stored !== null) {
    if (stored === 'null') throw new Error('Email account secret is missing or deleted.');
    return decryptPayload(secretRef, stored);
  }
  return mutateEmailAccountSecret(secretRef, async (secret) => {
    if (!secret) throw new Error('Email account secret is missing or deleted.');
    return { secret, result: secret };
  });
}

export async function deleteEmailAccountSecret(secretRef: string): Promise<void> {
  const key = credentialKeyForSecretRef(secretRef);
  await mutateUnifiedSecretValue(key, async () => null, storageScopeForSecretRef(secretRef));
}
