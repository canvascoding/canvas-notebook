import 'server-only';

import crypto from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { parseEnvDocument } from '@/app/lib/secrets/env-document';
import {
  assertUnifiedEnvReadable, getUnifiedEnvFilePath, getUnifiedEnvReadiness,
  patchUnifiedEnvEntries, readUnifiedEnvState, withUnifiedEnvLock,
} from '@/app/lib/secrets/unified-env-store';
import { configuredSecretMasterKeySource, isSecretReadinessError, SecretReadinessError, type SecretReadiness } from '@/app/lib/secrets/readiness';
import { assertConfiguredMcpEncryption } from './secret-store';
import { requireMcpCredentialScope, resolveMcpSecretEnvScope, type McpScope } from './scope';

const SYSTEM_SCOPE = { secretScope: 'system' as const };
const KEY_ENTRY = 'MCP_CREDENTIAL_KEY';
const PREVIOUS_KEYS_ENTRY = 'MCP_CREDENTIAL_PREVIOUS_KEYS';

export type McpEncryptionReadiness = SecretReadiness & { canInitialize: boolean };

function initializationMarkerPath(): string {
  return path.join(path.dirname(getUnifiedEnvFilePath(SYSTEM_SCOPE)), 'mcp-credential-key-initialization.json');
}

async function pathExists(filePath: string): Promise<boolean> {
  try { await fs.lstat(filePath); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Scan only managed secret/MCP stores; application workspace content is unrelated. */
async function hasPreviousMcpEncryption(): Promise<boolean> {
  if (await pathExists(initializationMarkerPath())) return true;
  const hasEnvHistory = async (filePath: string): Promise<boolean> => {
    let content: string;
    try { content = await fs.readFile(filePath, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const tokens = parseEnvDocument(content);
    return tokens.some(token => token.key?.startsWith('CANVAS_CREDENTIAL_MCP_')
      || [KEY_ENTRY, PREVIOUS_KEYS_ENTRY].includes(token.key || '') && Boolean(token.value?.trim()));
  };
  for (const override of [process.env.INTEGRATIONS_ENV_PATH, process.env.AGENTS_ENV_PATH]) {
    if (override?.trim() && await hasEnvHistory(path.resolve(override.trim()))) return true;
  }
  const root = resolveCanvasDataRoot();
  const candidates = [path.join(root, 'settings'), path.join(root, 'secrets'), path.join(root, 'system', 'secrets')];
  for (const parent of ['users', 'organizations']) {
    let children;
    try { children = await fs.readdir(path.join(root, parent), { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const child of children) {
      if (child.isSymbolicLink()) return true;
      if (!child.isDirectory()) continue;
      candidates.push(path.join(root, parent, child.name, 'secrets'), path.join(root, parent, child.name, 'mcp'));
    }
  }
  // A local backup may be the only remaining copy of credentials after a restore.
  for (const backup of [path.join(root, 'backups'), path.join(root, 'system', 'backups')]) {
    try { if ((await fs.readdir(backup)).length > 0) return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let visited = 0;
  const inspect = async (directory: string, depth = 0): Promise<boolean> => {
    if (depth > 12 || ++visited > 50_000) return true;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) { if (await inspect(filePath, depth + 1)) return true; continue; }
      if (!entry.isFile() || !/\.(?:env|json)$/u.test(entry.name)) continue;
      const stat = await fs.stat(filePath);
      if (stat.size > 10 * 1024 * 1024) return true;
      const content = await fs.readFile(filePath, 'utf8');
      if (entry.name.endsWith('.env')) {
        if (await hasEnvHistory(filePath)) return true;
      } else if (/"(?:sealed|keyId|ciphertext)"\s*:/u.test(content)
        || /(?:^|\/)mcp-oauth\/(?:.*\/)?(?:tokens|client|[^/]*state[^/]*)\.json$/u.test(filePath)
        || /(?:^|\/)\.state\//u.test(filePath)) return true;
    }
    return false;
  };
  if (!candidates.includes(path.dirname(getUnifiedEnvFilePath(SYSTEM_SCOPE)))) candidates.push(path.dirname(getUnifiedEnvFilePath(SYSTEM_SCOPE)));
  for (const candidate of candidates) if (await inspect(candidate)) return true;
  return false;
}

async function writeInitializationMarker(key: string, source: 'system' | 'environment'): Promise<void> {
  const filePath = initializationMarkerPath();
  if (await pathExists(filePath)) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await fs.open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, source, keyId: crypto.createHash('sha256').update(key).digest('hex'), initializedAt: new Date().toISOString() }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  const directory = await fs.open(path.dirname(filePath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Explicit OAuth preparation only; plain reads never generate or replace keys. */
export async function ensureMcpCredentialKey(): Promise<void> {
  await withUnifiedEnvLock(SYSTEM_SCOPE, async () => {
    const state = await readUnifiedEnvState(SYSTEM_SCOPE);
    assertUnifiedEnvReadable(state);
    const environmentKey = process.env.INTEGRATIONS_ENV_MASTER_KEY?.trim();
    const storedKey = state.entries.find(entry => entry.key === KEY_ENTRY)?.value.trim();
    if (environmentKey || storedKey) {
      await assertConfiguredMcpEncryption();
      await writeInitializationMarker(environmentKey || storedKey!, environmentKey ? 'environment' : 'system');
      return;
    }
    if (process.env.MCP_CREDENTIAL_PREVIOUS_KEYS?.trim() || await hasPreviousMcpEncryption()) throw new SecretReadinessError('mcp_credential_key_missing');
    const generated = crypto.randomBytes(32).toString('base64url');
    // Record the identity first. An interrupted initialization must never silently
    // replace a potentially persisted key with another random value on restart.
    await writeInitializationMarker(generated, 'system');
    await patchUnifiedEnvEntries([{ key: KEY_ENTRY, value: generated }], SYSTEM_SCOPE);
    await assertConfiguredMcpEncryption();
  });
}

export async function getMcpEncryptionReadiness(scope: McpScope): Promise<McpEncryptionReadiness> {
  const owned = requireMcpCredentialScope(scope);
  const owner = await getUnifiedEnvReadiness(resolveMcpSecretEnvScope(owned));
  if (owner.status !== 'ready') return { ...owner, canInitialize: false };
  const system = await getUnifiedEnvReadiness(SYSTEM_SCOPE);
  if (system.status !== 'ready') return { ...system, canInitialize: false };
  try {
    await assertConfiguredMcpEncryption();
    return { status: 'ready', masterKeySource: configuredSecretMasterKeySource(), canInitialize: false };
  } catch (error) {
    if (!isSecretReadinessError(error)) throw error;
    return {
      status: error.code, masterKeySource: configuredSecretMasterKeySource(),
      canInitialize: error.code === 'mcp_credential_key_missing' && !process.env.MCP_CREDENTIAL_PREVIOUS_KEYS?.trim() && !await hasPreviousMcpEncryption(),
    };
  }
}

export async function assertMcpEncryptionReady(scope: McpScope, options: { provision?: boolean } = {}): Promise<void> {
  const readiness = await getMcpEncryptionReadiness(scope);
  if (readiness.status === 'ready') {
    if (options.provision) await ensureMcpCredentialKey();
    return;
  }
  if (options.provision && readiness.canInitialize) { await ensureMcpCredentialKey(); return; }
  throw new SecretReadinessError(readiness.status);
}
