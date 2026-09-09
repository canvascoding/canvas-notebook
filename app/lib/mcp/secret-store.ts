import 'server-only';

import crypto from 'node:crypto';

import { readScopedEnvState, type EnvStorageScope } from '@/app/lib/integrations/env-config';

const ENVELOPE_VERSION = 1;
const KEY_ENTRY = 'MCP_CREDENTIAL_KEY';
const PREVIOUS_KEYS_ENTRY = 'MCP_CREDENTIAL_PREVIOUS_KEYS';
const MINIMUM_KEY_BYTES = 32;

export type McpSecretBinding = {
  ownerUserId: string;
  organizationId?: string | null;
  connectionId: string;
  purpose: string;
};

type McpSecretEnvelope = {
  version: 1;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

type KeyMaterial = {
  keyId: string;
  value: string;
  key: Buffer;
};

const INSTANCE_SCOPE: EnvStorageScope = { secretScope: 'legacy' };

function configurationError(message: string): Error {
  return new Error(`${message} Configure MCP credentials encryption in /settings?tab=integrations.`);
}

function requireBindingPart(value: string, label: string): string {
  if (!value || !value.trim()) throw new Error(`MCP secret binding requires ${label}.`);
  return value;
}

function additionalAuthenticatedData(binding: McpSecretBinding): Buffer {
  return Buffer.from(JSON.stringify({
    schema: 'canvas-mcp-secret-aad',
    version: ENVELOPE_VERSION,
    ownerUserId: requireBindingPart(binding.ownerUserId, 'ownerUserId'),
    organizationId: binding.organizationId ?? null,
    connectionId: requireBindingPart(binding.connectionId, 'connectionId'),
    purpose: requireBindingPart(binding.purpose, 'purpose'),
  }), 'utf8');
}

function keyMaterial(value: string): KeyMaterial {
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') < MINIMUM_KEY_BYTES) {
    throw configurationError(`MCP credential encryption keys must contain at least ${MINIMUM_KEY_BYTES} bytes.`);
  }
  return {
    keyId: crypto.createHash('sha256').update(normalized, 'utf8').digest('hex'),
    value: normalized,
    key: crypto.createHash('sha256').update(normalized, 'utf8').digest(),
  };
}

function parsePreviousKeys(value: string, source: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw configurationError(`${source} must be a JSON array of encryption keys.`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw configurationError(`${source} must be a JSON array of encryption keys.`);
  }
  return parsed;
}

async function configuredKeyValues(): Promise<{ active: string; previous: string[] }> {
  const environmentActive = process.env.INTEGRATIONS_ENV_MASTER_KEY?.trim();
  const environmentPrevious = process.env.MCP_CREDENTIAL_PREVIOUS_KEYS?.trim();
  if (environmentActive) {
    return {
      active: environmentActive,
      previous: environmentPrevious ? parsePreviousKeys(environmentPrevious, PREVIOUS_KEYS_ENTRY) : [],
    };
  }

  const state = await readScopedEnvState('integrations', INSTANCE_SCOPE);
  const configuredActive = state.entries.find((entry) => entry.key === KEY_ENTRY && entry.readable)?.value.trim();
  if (!configuredActive) throw configurationError('MCP credential encryption key is missing.');
  const configuredPrevious = state.entries.find((entry) => entry.key === PREVIOUS_KEYS_ENTRY && entry.readable)?.value.trim();
  return {
    active: configuredActive,
    previous: environmentPrevious
      ? parsePreviousKeys(environmentPrevious, PREVIOUS_KEYS_ENTRY)
      : configuredPrevious ? parsePreviousKeys(configuredPrevious, PREVIOUS_KEYS_ENTRY) : [],
  };
}

async function configuredKeys(): Promise<{ active: KeyMaterial; all: KeyMaterial[] }> {
  const values = await configuredKeyValues();
  const active = keyMaterial(values.active);
  const byId = new Map<string, KeyMaterial>([[active.keyId, active]]);
  for (const value of values.previous) {
    const material = keyMaterial(value);
    byId.set(material.keyId, material);
  }
  return { active, all: Array.from(byId.values()) };
}

function isBase64Url(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value);
}

function decodeBase64Url(value: unknown, label: string, expectedLength?: number): Buffer {
  if (!isBase64Url(value)) throw new Error(`Invalid MCP secret envelope ${label}.`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error(`Invalid MCP secret envelope ${label}.`);
  }
  return decoded;
}

function parseEnvelope(value: string): McpSecretEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid MCP secret envelope.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid MCP secret envelope.');
  }
  const envelope = parsed as Record<string, unknown>;
  const expectedKeys = ['ciphertext', 'iv', 'keyId', 'tag', 'version'];
  if (Object.keys(envelope).sort().join(',') !== expectedKeys.join(',')) {
    throw new Error('Invalid MCP secret envelope schema.');
  }
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported MCP secret envelope version: ${String(envelope.version)}.`);
  }
  if (typeof envelope.keyId !== 'string' || !/^[a-f0-9]{64}$/u.test(envelope.keyId)) {
    throw new Error('Invalid MCP secret envelope keyId.');
  }
  decodeBase64Url(envelope.iv, 'iv', 12);
  decodeBase64Url(envelope.tag, 'tag', 16);
  decodeBase64Url(envelope.ciphertext, 'ciphertext');
  return envelope as McpSecretEnvelope;
}

function serializePayload(payload: unknown): Buffer {
  const serialized = JSON.stringify(payload);
  if (typeof serialized !== 'string') throw new Error('MCP secret payload must be JSON serializable.');
  return Buffer.from(serialized, 'utf8');
}

export async function sealMcpSecret(payload: unknown, binding: McpSecretBinding): Promise<string> {
  const { active } = await configuredKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', active.key, iv);
  cipher.setAAD(additionalAuthenticatedData(binding));
  const ciphertext = Buffer.concat([cipher.update(serializePayload(payload)), cipher.final()]);
  const envelope: McpSecretEnvelope = {
    version: ENVELOPE_VERSION,
    keyId: active.keyId,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
  return JSON.stringify(envelope);
}

export async function openMcpSecret<T>(value: string, binding: McpSecretBinding): Promise<T> {
  const envelope = parseEnvelope(value);
  const { all } = await configuredKeys();
  const material = all.find((candidate) => candidate.keyId === envelope.keyId);
  if (!material) throw new Error('MCP secret was encrypted with an unavailable key.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', material.key, decodeBase64Url(envelope.iv, 'iv', 12));
    decipher.setAAD(additionalAuthenticatedData(binding));
    decipher.setAuthTag(decodeBase64Url(envelope.tag, 'tag', 16));
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64Url(envelope.ciphertext, 'ciphertext')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    throw new Error('MCP secret could not be authenticated for this binding.');
  }
}
