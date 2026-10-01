import crypto from 'node:crypto';
import fsSync, { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createAtomicTempPath, resolveScopedSecretsDir, resolveSystemSecretsDir,
  resolveScopedIntegrationsEnvPath, resolveScopedAgentsEnvPath,
  type SecretDataStorageScope,
} from '../runtime-data-paths';
import { withFileMutationLock } from './file-mutation-lock';
import { formatEnvValue, isEnvKey, parseEnvDocument, parseLegacyEnvDocument, updateEnvDocument } from './env-document';
import { isAuthenticatedLegacyEmailEnvelope } from './legacy-email-envelope';
import { configuredSecretMasterKeySource, SecretReadinessError, isSecretReadinessError, type SecretReadiness, type SecretReadinessCode } from './readiness';

export type EnvView = 'integrations' | 'agents';
export type SecretScope = SecretDataStorageScope | null | undefined;
export type SecretEnvEntry = { key: string; value: string; encrypted: boolean; readable: boolean; failure?: SecretReadinessCode };
export type UnifiedEnvState = {
  path: string; exists: boolean; rawContent: string; entries: SecretEnvEntry[];
  encryptionEnabled: boolean; revision: string; readable: boolean;
};
export type EnvPatch = { key: string; value: string | null };
export const AGENT_PROFILE_PREFIX = 'CANVAS_PROFILE_AGENTS__';
const PROFILE_PREFIX = 'CANVAS_PROFILE_';
const OWNER_PREFIX = 'CANVAS_PROFILE_OWNERS__';
const CREDENTIAL_PREFIX = 'CANVAS_CREDENTIAL_';
const DELETED_PROFILE = 'canvas:deleted:v1';

export class SecretRevisionConflictError extends Error {
  readonly code = 'SECRETS_REVISION_CONFLICT';
  readonly status = 409;
  constructor() { super('Secrets changed since this editor was loaded. Reload before saving.'); this.name = 'SecretRevisionConflictError'; }
}

function isSystem(scope: SecretScope): boolean {
  const kind = scope?.secretScope ?? scope?.scopeType;
  return kind ? kind === 'system' || kind === 'legacy' : !scope?.userId?.trim() && !scope?.organizationId?.trim();
}
export function getUnifiedEnvFilePath(scope?: SecretScope): string {
  if (isSystem(scope)) return path.resolve(process.env.CANVAS_SECRETS_ENV_PATH?.trim() || path.join(resolveSystemSecretsDir(), 'Canvas-Secrets.env'));
  const normalized = scope?.secretScope ? scope : { ...scope, secretScope: scope?.scopeType as SecretDataStorageScope['secretScope'] };
  return path.join(resolveScopedSecretsDir(normalized), 'Canvas-Secrets.env');
}
function masterKey(): string | null {
  return process.env.CANVAS_SECRETS_MASTER_KEY?.trim() || process.env.INTEGRATIONS_ENV_MASTER_KEY?.trim() || process.env.AGENTS_ENV_MASTER_KEY?.trim() || null;
}
function encrypt(value: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), iv);
  const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:env:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${content.toString('hex')}`;
}
function decrypt(value: string, secret: string | null): string {
  if (!value.startsWith('enc:')) return value;
  const parts = /^enc:(?:env:)?v1:([a-f0-9]{24}):([a-f0-9]{32}):((?:[a-f0-9]{2})*)$/u.exec(value);
  if (!parts) throw new SecretReadinessError('invalid_secret_format');
  if (!secret) throw new SecretReadinessError('master_key_missing');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), Buffer.from(parts[1], 'hex'));
    decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'hex')), decipher.final()]).toString('utf8');
  } catch { throw new SecretReadinessError('decryption_failed'); }
}

function legacyEmailKeys(filePath: string, tokens: ReturnType<typeof parseEnvDocument>, secret: string | null): string[] {
  const candidates = new Set<string>();
  const configured = process.env.INTEGRATIONS_ENV_MASTER_KEY?.trim();
  if (configured) candidates.add(configured);
  const addStoredKey = (raw: string | null, originalKey: string | null, legacy = false) => {
    if (raw === null) return;
    const values = legacy ? parseLegacyEnvDocument(raw) : parseEnvDocument(raw);
    const token = values.find(entry => entry.key === 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY');
    if (!token?.value) return;
    try {
      const value = decrypt(token.value, originalKey).trim();
      if (value && !value.startsWith('enc:')) candidates.add(value);
    } catch { /* An unavailable fallback never makes an unauthenticated record readable. */ }
  };
  const local = tokens.find(entry => entry.key === 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY');
  if (local?.value) {
    try { const value = decrypt(local.value, secret).trim(); if (value && !value.startsWith('enc:')) candidates.add(value); } catch { /* Checked by the ordinary entry reader too. */ }
  }
  const systemPath = getUnifiedEnvFilePath({ secretScope: 'system' });
  if (filePath !== systemPath) {
    const canonical = readFileSync(systemPath);
    if (canonical !== null) addStoredKey(canonical, masterKey());
    else for (const source of legacySources({ secretScope: 'system' })) {
      addStoredKey(readFileSync(source.path), process.env[source.view === 'agents' ? 'AGENTS_ENV_MASTER_KEY' : 'INTEGRATIONS_ENV_MASTER_KEY']?.trim() || null, true);
    }
  }
  return [...candidates];
}

function decodeStoredValue(key: string, value: string, secret: string | null, emailKeys: readonly string[]): string {
  if (/^CANVAS_CREDENTIAL_EMAIL_[A-F0-9]{64}$/u.test(key) && value.startsWith('enc:v1:')
    && isAuthenticatedLegacyEmailEnvelope(value, emailKeys)) return value;
  return decrypt(value, secret);
}
function legacySources(scope: SecretScope): Array<{ path: string; view: EnvView; label: string }> {
  const result: Array<{ path: string; view: EnvView; label: string }> = [];
  for (const view of ['integrations', 'agents'] as const) {
    const resolver = view === 'agents' ? resolveScopedAgentsEnvPath : resolveScopedIntegrationsEnvPath;
    if (isSystem(scope)) {
      const override = process.env[view === 'agents' ? 'AGENTS_ENV_PATH' : 'INTEGRATIONS_ENV_PATH']?.trim();
      if (override) result.push({ path: path.resolve(override), view, label: `configured ${view}` });
      result.push({ path: resolver(null), view, label: `legacy ${view}` });
      result.push({ path: resolver({ secretScope: 'system' }), view, label: `system ${view}` });
    } else result.push({ path: resolver(scope?.secretScope ? scope : { ...scope, secretScope: scope?.scopeType as SecretDataStorageScope['secretScope'] }), view, label: view });
  }
  const seen = new Set<string>();
  return result.filter(source => !seen.has(source.path) && Boolean(seen.add(source.path)));
}
function mergeLegacy(sources: Array<{ raw: string; view: EnvView; label: string }>): string {
  let content = '';
  const values = new Map<string, string>();
  const canonical = new Map<string, string>();
  for (const source of sources) {
    const tokens = parseLegacyEnvDocument(source.raw);
    const secret = process.env[source.view === 'agents' ? 'AGENTS_ENV_MASTER_KEY' : 'INTEGRATIONS_ENV_MASTER_KEY']?.trim() || null;
    const emailKeys = legacyEmailKeys('', tokens, secret);
    content += `# Imported ${source.label} settings\n`;
    for (const token of tokens) {
      if (!token.key) { content += token.raw; continue; }
      let value: string;
      try { value = decodeStoredValue(token.key, token.value!, secret, emailKeys); } catch (error) {
        throw new SecretReadinessError(isSecretReadinessError(error) ? error.code : 'invalid_secret_format', `Cannot migrate encrypted ${source.view} entry ${token.key}; configure its original master key. See /settings?tab=secrets.`);
      }
      let key = token.key;
      const sourceKey = `${source.view}:${token.key}`;
      if (canonical.has(sourceKey)) {
        if (canonical.get(sourceKey) === value) {
          if (token.suffix?.trim().startsWith('#')) content += `${token.suffix.trimEnd()}\n`;
          continue;
        }
        // A dormant source can never replace this view's established value.
        key = `${PROFILE_PREFIX}SOURCE_${source.view.toUpperCase()}__${token.key}`;
      } else {
        canonical.set(sourceKey, value);
        if (values.has(key)) {
          if (values.get(key) === value) {
            if (source.view === 'agents' && !key.startsWith(PROFILE_PREFIX) && !key.startsWith(CREDENTIAL_PREFIX)) content = updateEnvDocument(parseEnvDocument(content), new Map([[`${OWNER_PREFIX}${key}`, 'shared']]));
            if (token.suffix?.trim().startsWith('#')) content += `${token.suffix.trimEnd()}\n`;
            continue;
          }
          key = `${AGENT_PROFILE_PREFIX}${token.key}`;
        }
      }
      const candidate = key;
      let index = 2;
      while (values.has(key) && values.get(key) !== value) key = `${candidate}__${index++}`;
      if (values.get(key) === value) {
        if (token.suffix?.trim().startsWith('#')) content += `${token.suffix.trimEnd()}\n`;
        continue;
      }
      values.set(key, value);
      if (!key.startsWith(PROFILE_PREFIX) && !key.startsWith(CREDENTIAL_PREFIX)) content += `${OWNER_PREFIX}${key}=${source.view}\n`;
      content += `${key}=${formatEnvValue(value)}${token.suffix?.trim() ? token.suffix : '\n'}`;
      if (!content.endsWith('\n')) content += '\n';
    }
  }
  return content;
}
async function readFile(filePath: string): Promise<string | null> {
  try { return await fs.readFile(filePath, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function readFileSync(filePath: string): string | null {
  try { return fsSync.readFileSync(filePath, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function writePhysical(filePath: string, logicalRaw: string): Promise<void> {
  const tokens = parseEnvDocument(logicalRaw);
  const secret = masterKey();
  const changes = new Map<string, string | null>();
  if (secret) for (const token of tokens) if (token.key && token.value) changes.set(token.key, encrypt(token.value, secret));
  const content = updateEnvDocument(tokens, changes);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = createAtomicTempPath(filePath);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, filePath);
    const directory = await fs.open(path.dirname(filePath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}
async function ensureMigrated(scope: SecretScope): Promise<void> {
  const filePath = getUnifiedEnvFilePath(scope);
  if (await readFile(filePath) !== null) return;
  const sources: Array<{ raw: string; view: EnvView; label: string }> = [];
  for (const source of legacySources(scope)) {
    const raw = await readFile(source.path);
    if (raw !== null) sources.push({ ...source, raw });
  }
  if (sources.length) await writePhysical(filePath, mergeLegacy(sources));
}
function stateFromPhysical(filePath: string, physical: string | null): UnifiedEnvState {
  const tokens = parseEnvDocument(physical ?? '');
  const changes = new Map<string, string | null>();
  const entries: SecretEnvEntry[] = [];
  const secret = masterKey();
  const emailKeys = tokens.some(token => token.key?.startsWith('CANVAS_CREDENTIAL_EMAIL_') && token.value?.startsWith('enc:v1:'))
    ? legacyEmailKeys(filePath, tokens, secret) : [];
  for (const token of tokens) {
    if (!token.key) continue;
    const encrypted = token.value!.startsWith('enc:');
    try {
      const value = decodeStoredValue(token.key, token.value!, secret, emailKeys);
      entries.push({ key: token.key, value, encrypted, readable: true });
      if (encrypted) changes.set(token.key, value);
    } catch (error) {
      entries.push({ key: token.key, value: '', encrypted, readable: false, failure: isSecretReadinessError(error) ? error.code : 'invalid_secret_format' });
      changes.set(token.key, '');
    }
  }
  return { path: filePath, exists: physical !== null, rawContent: updateEnvDocument(tokens, changes), entries,
    encryptionEnabled: Boolean(secret), revision: crypto.createHash('sha256').update(physical === null ? 'missing\0' : `exists\0${physical}`).digest('hex'),
    readable: entries.every(entry => entry.readable) };
}
async function currentState(scope: SecretScope): Promise<UnifiedEnvState> {
  const filePath = getUnifiedEnvFilePath(scope);
  return stateFromPhysical(filePath, await readFile(filePath));
}
export async function withUnifiedEnvLock<T>(scope: SecretScope, operation: () => Promise<T>): Promise<T> {
  return withFileMutationLock(getUnifiedEnvFilePath(scope), async () => { await ensureMigrated(scope); return operation(); });
}
export async function readUnifiedEnvState(scope?: SecretScope): Promise<UnifiedEnvState> {
  return withUnifiedEnvLock(scope, () => currentState(scope));
}
function requireReadable(state: UnifiedEnvState): void {
  if (!state.readable) throw new SecretReadinessError(state.entries.find(entry => !entry.readable)?.failure || 'decryption_failed');
}

export function assertUnifiedEnvReadable(state: UnifiedEnvState): void { requireReadable(state); }

export async function getUnifiedEnvReadiness(scope?: SecretScope): Promise<SecretReadiness> {
  const masterKeySource = configuredSecretMasterKeySource();
  try {
    const state = await readUnifiedEnvState(scope);
    return { status: state.readable ? 'ready' : state.entries.find(entry => !entry.readable)?.failure || 'decryption_failed', masterKeySource };
  } catch (error) {
    if (isSecretReadinessError(error)) return { status: error.code, masterKeySource };
    if (error instanceof Error && /Invalid|Duplicate|Unterminated|Unexpected/u.test(error.message)) return { status: 'invalid_secret_format', masterKeySource };
    throw error;
  }
}
function checkRevision(state: UnifiedEnvState, revision?: string): void {
  if (revision !== undefined && revision !== state.revision) throw new SecretRevisionConflictError();
}
async function applyUnifiedPatches(patches: EnvPatch[], scope?: SecretScope, baseRevision?: string, allowCredentials = false): Promise<UnifiedEnvState> {
  return withUnifiedEnvLock(scope, async () => {
    const state = await currentState(scope); requireReadable(state); checkRevision(state, baseRevision);
    const changes = new Map<string, string | null>();
    const existing = new Map(state.entries.map(entry => [entry.key, entry.value]));
    const seen = new Set<string>();
    for (const patch of patches) {
      if (patch.key.startsWith(OWNER_PREFIX) || (!allowCredentials && patch.key.startsWith(CREDENTIAL_PREFIX))) throw new Error('Protected connection credentials and ownership metadata require their storage adapters.');
      if (!isEnvKey(patch.key) || seen.has(patch.key)) throw new Error(`Invalid or duplicate ENV key: ${patch.key}.`);
      seen.add(patch.key);
      if (patch.value === null ? existing.has(patch.key) : existing.get(patch.key) !== patch.value) changes.set(patch.key, patch.value);
      if (patch.value === null && !patch.key.startsWith(PROFILE_PREFIX) && !patch.key.startsWith(CREDENTIAL_PREFIX) && existing.has(`${OWNER_PREFIX}${patch.key}`)) changes.set(`${OWNER_PREFIX}${patch.key}`, null);
    }
    if (state.exists && changes.size === 0) return state;
    await writePhysical(state.path, updateEnvDocument(parseEnvDocument(state.rawContent), changes));
    return currentState(scope);
  });
}
export async function patchUnifiedEnvEntries(patches: EnvPatch[], scope?: SecretScope, baseRevision?: string): Promise<UnifiedEnvState> {
  return applyUnifiedPatches(patches, scope, baseRevision);
}
/** Expert raw view includes profile aliases; typed credentials are protected from raw editing. */
export async function replaceUnifiedEnvRaw(raw: string, baseRevision: string, scope?: SecretScope): Promise<UnifiedEnvState> {
  return withUnifiedEnvLock(scope, async () => {
    const state = await currentState(scope); requireReadable(state); checkRevision(state, baseRevision);
    const proposed = new Map(parseEnvDocument(raw).filter(token => token.key).map(token => [token.key!, token.value!]));
    for (const entry of state.entries) if (entry.key.startsWith(CREDENTIAL_PREFIX) || entry.key.startsWith(OWNER_PREFIX)) {
      if (proposed.has(entry.key) && proposed.get(entry.key) !== entry.value) throw new Error('Typed connection credentials must be edited through their connection settings.');
      proposed.delete(entry.key);
    }
    for (const key of proposed.keys()) if (key.startsWith(CREDENTIAL_PREFIX) || key.startsWith(OWNER_PREFIX)) throw new Error('Typed connection credentials cannot be created in the raw editor.');
    const protectedEntries = new Map(state.entries.filter(entry => entry.key.startsWith(CREDENTIAL_PREFIX) || entry.key.startsWith(OWNER_PREFIX)).map(entry => [entry.key, entry.value]));
    await writePhysical(state.path, updateEnvDocument(parseEnvDocument(raw), protectedEntries));
    return currentState(scope);
  });
}
export function projectEnvView(state: UnifiedEnvState, view: EnvView): UnifiedEnvState & { scope: EnvView } {
  const owners = new Map(state.entries.filter(entry => entry.key.startsWith(OWNER_PREFIX)).map(entry => [entry.key.slice(OWNER_PREFIX.length), entry.value]));
  const entries = new Map(state.entries.filter(entry => !entry.key.startsWith(PROFILE_PREFIX) && !entry.key.startsWith(CREDENTIAL_PREFIX) && (!owners.has(entry.key) || owners.get(entry.key) === 'shared' || owners.get(entry.key) === view)).map(entry => [entry.key, entry]));
  if (view === 'agents') for (const entry of state.entries) if (entry.key.startsWith(AGENT_PROFILE_PREFIX)) {
    const key = entry.key.slice(AGENT_PROFILE_PREFIX.length);
    if (entry.value === DELETED_PROFILE) entries.delete(key);
    else entries.set(key, { ...entry, key });
  }
  const physicalTokens = parseEnvDocument(state.rawContent);
  const changes = new Map<string, string | null>();
  for (const token of physicalTokens) if (token.key) changes.set(token.key, entries.get(token.key)?.value ?? null);
  for (const entry of entries.values()) changes.set(entry.key, entry.value);
  return { ...state, scope: view, entries: [...entries.values()], rawContent: updateEnvDocument(physicalTokens, changes) };
}
/** Full replacements affect only their logical view. Callers with a category subset should use patches. */
export async function replaceEnvView(view: EnvView, entries: Array<{ key: string; value: string }>, scope?: SecretScope, raw?: string): Promise<UnifiedEnvState & { scope: EnvView }> {
  return withUnifiedEnvLock(scope, async () => {
    const state = await currentState(scope); requireReadable(state);
    const old = projectEnvView(state, view);
    const next = new Map<string, string>();
    for (const entry of entries) {
      if (!isEnvKey(entry.key) || entry.key.startsWith(PROFILE_PREFIX) || entry.key.startsWith(CREDENTIAL_PREFIX) || next.has(entry.key)) throw new Error(`Invalid, protected or duplicate ENV key: ${entry.key}.`);
      next.set(entry.key, entry.value);
    }
    const base = new Map(state.entries.map(entry => [entry.key, entry.value]));
    const changes = new Map<string, string | null>();
    for (const previous of old.entries) if (!next.has(previous.key)) {
      if (view === 'agents') {
        if (base.get(`${OWNER_PREFIX}${previous.key}`) === 'agents') {
          changes.set(previous.key, null); changes.set(`${OWNER_PREFIX}${previous.key}`, null);
          changes.set(`${AGENT_PROFILE_PREFIX}${previous.key}`, null);
        } else changes.set(`${AGENT_PROFILE_PREFIX}${previous.key}`, DELETED_PROFILE);
      }
      else {
        const profileKey = `${AGENT_PROFILE_PREFIX}${previous.key}`;
        if (!base.has(profileKey) && (!base.has(`${OWNER_PREFIX}${previous.key}`) || base.get(`${OWNER_PREFIX}${previous.key}`) === 'shared')) changes.set(profileKey, previous.value);
        changes.set(`${OWNER_PREFIX}${previous.key}`, null);
        changes.set(previous.key, null);
      }
    }
    for (const [key, value] of next) {
      if (old.entries.find(entry => entry.key === key)?.value === value) continue;
      if (view === 'agents' && base.has(key) && base.get(key) !== value) changes.set(`${AGENT_PROFILE_PREFIX}${key}`, value);
      else {
        changes.set(key, value);
        if (!base.has(key)) changes.set(`${OWNER_PREFIX}${key}`, view);
        else if (view === 'agents' && base.get(`${OWNER_PREFIX}${key}`) === 'integrations') changes.set(`${OWNER_PREFIX}${key}`, 'shared');
        else if (view === 'integrations' && (base.get(`${OWNER_PREFIX}${key}`) === 'agents' || base.get(`${OWNER_PREFIX}${key}`) === 'shared' || !base.has(`${OWNER_PREFIX}${key}`))) {
          if (!base.has(`${AGENT_PROFILE_PREFIX}${key}`)) changes.set(`${AGENT_PROFILE_PREFIX}${key}`, base.get(key)!);
          changes.set(`${OWNER_PREFIX}${key}`, 'integrations');
        }
        if (view === 'agents') changes.set(`${AGENT_PROFILE_PREFIX}${key}`, null);
      }
    }
    let content = updateEnvDocument(parseEnvDocument(state.rawContent), changes);
    if (raw !== undefined) {
      // Keep comments from an explicitly supplied raw edit while preserving hidden records.
      const comments = parseEnvDocument(raw).flatMap(token => !token.key ? [token.raw] : token.suffix?.trim().startsWith('#') ? [`${token.suffix.trimEnd()}\n`] : []).filter(comment => comment.trim() && !content.includes(comment)).join('');
      content = comments + (comments && !comments.endsWith('\n') ? '\n' : '') + content;
    }
    if (state.exists && content === state.rawContent) return old;
    await writePhysical(state.path, content);
    return projectEnvView(await currentState(scope), view);
  });
}
/** Read-only legacy fallback is allowed before the first asynchronous migration. */
export function readUnifiedSecretValue(key: string, scope?: SecretScope): string | null {
  const filePath = getUnifiedEnvFilePath(scope);
  const physical = readFileSync(filePath);
  let state: UnifiedEnvState;
  if (physical !== null) state = stateFromPhysical(filePath, physical);
  else {
    const sources = legacySources(scope).flatMap(source => { const raw = readFileSync(source.path); return raw === null ? [] : [{ ...source, raw }]; });
    const logical = mergeLegacy(sources);
    // Legacy values have already been decrypted with their original keys.
    const entry = parseEnvDocument(logical).find(token => token.key === key);
    return entry?.value ?? null;
  }
  const entry = state.entries.find(entry => entry.key === key);
  if (entry && !entry.readable) throw new SecretReadinessError(entry.failure || 'decryption_failed', `Secret ${key} cannot be decrypted safely. See /settings?tab=secrets.`);
  return entry?.value ?? null;
}
/** A callback's read/refresh/write sequence remains under one cross-process lock. 'null' is a durable tombstone payload. */
export async function mutateUnifiedSecretValue(key: string, operation: (value: string | null) => Promise<string | null>, scope?: SecretScope): Promise<string | null> {
  return withUnifiedEnvLock(scope, async () => {
    const state = await currentState(scope); requireReadable(state);
    if (!isEnvKey(key)) throw new Error(`Invalid ENV key: ${key}.`);
    const current = state.entries.find(entry => entry.key === key)?.value ?? null;
    const value = await operation(current);
    // Null deletes a typed value durably instead of reviving its legacy fallback.
    const encoded = value === null ? 'null' : value;
    if (encoded !== current) await applyUnifiedPatches([{ key, value: encoded }], scope, undefined, true);
    return value;
  });
}
