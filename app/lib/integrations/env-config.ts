import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

const DEFAULT_ENV_PATH = '/home/node/canvas-integrations.env';
const ENCRYPTED_PREFIX = 'enc:v1';

export interface IntegrationEnvEntry {
  key: string;
  value: string;
  encrypted: boolean;
}

export interface IntegrationEnvState {
  path: string;
  exists: boolean;
  rawContent: string;
  entries: IntegrationEnvEntry[];
  encryptionEnabled: boolean;
}

interface ParsedEnvEntry {
  key: string;
  value: string;
  encrypted: boolean;
}

function getEnvFilePath(): string {
  const configuredPath = process.env.INTEGRATIONS_ENV_PATH?.trim();
  return configuredPath || DEFAULT_ENV_PATH;
}

function getMasterSecret(): string | null {
  const value = process.env.INTEGRATIONS_ENV_MASTER_KEY?.trim();
  return value || null;
}

function deriveEncryptionKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

function isEncryptedValue(value: string): boolean {
  return value.startsWith(`${ENCRYPTED_PREFIX}:`);
}

function encryptValue(value: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const key = deriveEncryptionKey(secret);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptValue(value: string, secret: string): string {
  if (!isEncryptedValue(value)) {
    return value;
  }

  const parts = value.split(':');
  if (parts.length !== 5) {
    throw new Error('Invalid encrypted value format');
  }

  const [, version, ivHex, tagHex, encryptedHex] = parts;
  if (version !== 'v1') {
    throw new Error(`Unsupported encrypted value version: ${version}`);
  }

  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const key = deriveEncryptionKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString('utf8');
}

function parseEnv(content: string): ParsedEnvEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: ParsedEnvEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!key) {
      continue;
    }

    let rawValue = normalized.slice(equalsIndex + 1).trim();
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      rawValue = rawValue.slice(1, -1);
    }

    entries.push({
      key,
      value: rawValue,
      encrypted: isEncryptedValue(rawValue),
    });
  }

  return entries;
}

function formatEnvValue(value: string): string {
  if (!value) {
    return '';
  }
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function serializeEntries(entries: ParsedEnvEntry[]): string {
  const lines = entries
    .filter((entry) => entry.key && isValidEnvKey(entry.key))
    .map((entry) => `${entry.key}=${formatEnvValue(entry.value)}`);

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function writeIntegrationsRaw(rawContent: string): Promise<void> {
  const filePath = getEnvFilePath();
  await ensureParentDirectory(filePath);

  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const content = rawContent.endsWith('\n') || rawContent.length === 0 ? rawContent : `${rawContent}\n`;
  await fs.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(tmpPath, 0o600);
  await fs.rename(tmpPath, filePath);
}

export async function readIntegrationsEnvState(): Promise<IntegrationEnvState> {
  const filePath = getEnvFilePath();
  let rawContent = '';
  let exists = true;

  try {
    rawContent = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      exists = false;
      rawContent = '';
    } else {
      throw error;
    }
  }

  const parsed = parseEnv(rawContent);
  const secret = getMasterSecret();

  const entries: IntegrationEnvEntry[] = parsed.map((entry) => {
    if (entry.encrypted && secret) {
      try {
        return {
          key: entry.key,
          value: decryptValue(entry.value, secret),
          encrypted: true,
        };
      } catch {
        return {
          key: entry.key,
          value: '',
          encrypted: true,
        };
      }
    }

    return {
      key: entry.key,
      value: entry.value,
      encrypted: entry.encrypted,
    };
  });

  return {
    path: filePath,
    exists,
    rawContent,
    entries,
    encryptionEnabled: Boolean(secret),
  };
}

export async function replaceIntegrationsEntries(
  entries: Array<{ key: string; value: string }>
): Promise<IntegrationEnvState> {
  const secret = getMasterSecret();
  const normalized: ParsedEnvEntry[] = [];

  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key || !isValidEnvKey(key)) {
      continue;
    }

    const plainValue = entry.value ?? '';
    normalized.push({
      key,
      value: secret && plainValue ? encryptValue(plainValue, secret) : plainValue,
      encrypted: Boolean(secret && plainValue),
    });
  }

  const byKey = new Map<string, ParsedEnvEntry>();
  for (const entry of normalized) {
    byKey.set(entry.key, entry);
  }

  const sorted = Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  await writeIntegrationsRaw(serializeEntries(sorted));
  return readIntegrationsEnvState();
}

export async function getGoogleApiKeyFromIntegrations(): Promise<string | null> {
  const state = await readIntegrationsEnvState();
  const byKey = new Map(state.entries.map((entry) => [entry.key, entry.value]));

  return (
    byKey.get('GOOGLE_API_KEY') ||
    byKey.get('API_KEY') ||
    byKey.get('GEMINI_API_KEY') ||
    process.env.GOOGLE_API_KEY ||
    process.env.API_KEY ||
    process.env.GEMINI_API_KEY ||
    null
  );
}

