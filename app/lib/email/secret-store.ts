import 'server-only';

import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

import { readScopedEnvState, replaceScopedEnvEntries } from '@/app/lib/integrations/env-config';
import { resolveSecretsDir, resolveUserSecretsDir } from '@/app/lib/runtime-data-paths';

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
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function legacySecretRoot(): string {
  return path.join(resolveSecretsDir(), 'email-accounts');
}

export function emailAccountSecretRef(userId: string, accountId: string): string {
  return `${safePathSegment(userId)}/${safePathSegment(accountId)}.json.enc`;
}

function secretRefSegments(secretRef: string): string[] {
  return secretRef.split('/').map(safePathSegment).filter(Boolean);
}

function userIdFromSecretRef(secretRef: string): string | null {
  const [userId] = secretRefSegments(secretRef);
  return userId || null;
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

async function ensurePrivateDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
}

function deriveEncryptionKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

async function readMasterSecretFromScope(userId: string | null, createIfMissing: boolean): Promise<string | null> {
  const configured = process.env.INTEGRATIONS_ENV_MASTER_KEY?.trim();
  if (configured) return configured;

  const storageScope = userId ? { userId } : { secretScope: 'legacy' as const };
  const state = await readScopedEnvState('integrations', storageScope);
  const existing = state.entries.find((entry) => entry.key === FALLBACK_KEY)?.value.trim();
  if (existing && !existing.startsWith(`${ENCRYPTED_PREFIX}:`)) return existing;
  if (!createIfMissing) return null;

  const generated = crypto.randomBytes(32).toString('base64url');
  await replaceScopedEnvEntries('integrations', [
    ...state.entries
      .filter((entry) => entry.key !== FALLBACK_KEY)
      .map((entry) => ({ key: entry.key, value: entry.value })),
    { key: FALLBACK_KEY, value: generated },
  ], storageScope);
  return generated;
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
  return JSON.parse(plain.toString('utf8')) as EmailAccountSecret;
}

async function decryptPayload(secretRef: string, value: string): Promise<EmailAccountSecret> {
  if (!value.startsWith(`${ENCRYPTED_PREFIX}:`)) {
    return JSON.parse(value) as EmailAccountSecret;
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

export async function writeEmailAccountSecret(secretRef: string, payload: EmailAccountSecret): Promise<void> {
  const filePath = secretPath(secretRef);
  await ensurePrivateDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, await encryptPayload(secretRef, payload), { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(tmpPath, 0o600).catch(() => undefined);
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function readEmailAccountSecret(secretRef: string): Promise<EmailAccountSecret> {
  const primaryPath = secretPath(secretRef);
  const legacyPath = legacySecretPath(secretRef);
  try {
    const primaryValue = await fs.readFile(primaryPath, 'utf8');
    return await decryptPayload(secretRef, primaryValue);
  } catch (error) {
    if (primaryPath === legacyPath || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return decryptPayload(secretRef, await fs.readFile(legacyPath, 'utf8'));
  }
}

export async function deleteEmailAccountSecret(secretRef: string): Promise<void> {
  await fs.rm(secretPath(secretRef), { force: true }).catch(() => undefined);
  await fs.rm(legacySecretPath(secretRef), { force: true }).catch(() => undefined);
}
