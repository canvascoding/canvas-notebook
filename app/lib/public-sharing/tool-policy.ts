import 'server-only';

import { createHash } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { SqlConnection } from '../db';
import { resolveEffectiveProviderConfig } from '../agents/effective-runtime-config';
import { normalizeManagedAgentId, readAgentProfileOnConnection } from '../agents/registry';
import { DEFAULT_MANAGED_AGENT_ID, PI_RUNTIME_CONFIG_FILE, PI_RUNTIME_CONFIG_PATH, readPiRuntimeConfig } from '../agents/storage';
import { captureCurrentAgentToolInvocation, withCapturedAgentToolInvocation } from '../pi/agent-tool-invocation';
import { DISABLED_ALL_TOOLS_SENTINEL, getDefaultEnabledToolNames, isDefaultToolsConfig,
  normalizeEnabledToolsConfig, resolveEnabledToolNames } from '../pi/enabled-tools';
import { resolveLegacySettingsStoragePath } from '../settings-storage';
import type { WorkspaceAgentToolPrincipalAccess } from '../workspaces/request-principal';

export class PublicShareToolPolicyError extends Error {
  constructor(readonly code: 'TOOL_POLICY_DENIED' | 'TOOL_POLICY_CHANGED' | 'TOOL_POLICY_UNAVAILABLE') {
    super(code); this.name = 'PublicShareToolPolicyError';
  }
  get status() { return this.code === 'TOOL_POLICY_DENIED' ? 403 : this.code === 'TOOL_POLICY_CHANGED' ? 409 : 503; }
}

type ConfigCapture = Readonly<{ path: string; handle: FileHandle; identity: BigIntStats; digest: string }
  | { path: string; handle: null }>;
type Policy = Readonly<{ assertCurrent: (database: SqlConnection, access: WorkspaceAgentToolPrincipalAccess) => Promise<void> }>;
const CONFIG_BYTES = 1024 * 1024;
const PUBLIC_TOOL = 'public_share_file';
const identityKeys = ['dev','ino','mode','nlink','uid','gid','size','mtimeNs','ctimeNs','birthtimeNs'] as const;
const missing = (error: unknown) => !!error && typeof error === 'object' && Reflect.get(error,'code') === 'ENOENT';
function fail(code: PublicShareToolPolicyError['code']): never { throw new PublicShareToolPolicyError(code); }
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return identityKeys.every(key => left[key] === right[key]);
}
function regular(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== BigInt(1) || stat.size < BigInt(0) || stat.size > BigInt(CONFIG_BYTES)) fail('TOOL_POLICY_UNAVAILABLE');
}

/** Positional reads never consume the held FD. Only the bounded digest survives. */
async function digest(handle: FileHandle, stat: BigIntStats): Promise<string> {
  regular(stat);
  const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
  const size = Number(stat.size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(buffer,0,Math.min(buffer.length,size-offset),offset);
    if (!result.bytesRead) fail('TOOL_POLICY_CHANGED');
    hash.update(buffer.subarray(0,result.bytesRead)); offset += result.bytesRead;
  }
  if ((await handle.read(buffer,0,1,offset)).bytesRead || !sameIdentity(stat,await handle.stat({bigint:true}))) fail('TOOL_POLICY_CHANGED');
  return hash.digest('hex');
}

async function captureConfig(filePath: string, handles: FileHandle[]): Promise<ConfigCapture> {
  let handle: FileHandle;
  try { handle = await fs.open(filePath,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (!missing(error)) fail('TOOL_POLICY_UNAVAILABLE');
    try { await fs.lstat(filePath); } catch (failure) {
      if (missing(failure)) return Object.freeze({path:filePath,handle:null});
      fail('TOOL_POLICY_UNAVAILABLE');
    }
    return fail('TOOL_POLICY_CHANGED');
  }
  handles.push(handle);
  const identity = await handle.stat({bigint:true}); regular(identity);
  const contentDigest = await digest(handle,identity);
  const current = await fs.lstat(filePath,{bigint:true});
  if (!sameIdentity(identity,current)) fail('TOOL_POLICY_CHANGED');
  return Object.freeze({path:filePath,handle,identity,digest:contentDigest});
}

/** Rejection checks only: never reopen, migrate, prepare or publish settings. */
async function assertConfig(captures: readonly ConfigCapture[]): Promise<void> {
  try {
    for (const captured of captures) {
      if (!captured.handle) {
        try { await fs.lstat(captured.path); } catch (error) { if (missing(error)) continue; throw error; }
        fail('TOOL_POLICY_CHANGED');
      }
      const current = await captured.handle.stat({bigint:true});
      if (!sameIdentity(captured.identity,current)
        || !sameIdentity(captured.identity,await fs.lstat(captured.path,{bigint:true}))
        || await digest(captured.handle,current) !== captured.digest
        || !sameIdentity(captured.identity,await fs.lstat(captured.path,{bigint:true}))) fail('TOOL_POLICY_CHANGED');
    }
  } catch (error) {
    if (error instanceof PublicShareToolPolicyError) throw error;
    fail('TOOL_POLICY_CHANGED');
  }
}

/** Policy only, never a database/actor grant. Preparation precedes the actual
 * Principal factory; operation retains that factory through COMMIT and cleanup.
 * public_share_file is a direct tool, not a progressive gateway operation. */
export async function withPreparedPublicShareToolPolicy<T>(operation: (policy: Policy) => Promise<T>): Promise<T> {
  return withPreparedFixedDocumentToolPolicy(PUBLIC_TOOL, operation);
}

/** Fixed read-only tool-use policy. This supplies no workspace or SQL grant. */
export async function withPreparedDocumentSearchToolPolicy<T>(operation: (policy: Policy) => Promise<T>): Promise<T> {
  return withPreparedFixedDocumentToolPolicy('search_documents', operation);
}

/** Fixed native edit tool use, separately from workspace WRITE authority. */
export async function withPreparedDocumentEditToolPolicy<T>(operation: (policy: Policy) => Promise<T>): Promise<T> {
  return withPreparedFixedDocumentToolPolicy('edit_file', operation);
}

/** Fixed genuine create callers; this is policy only, never a Principal. */
export async function withPreparedDocumentCreateToolPolicy<T>(operation: (policy: Policy) => Promise<T>): Promise<T> {
  const invocation = captureCurrentAgentToolInvocation();
  return withCapturedAgentToolInvocation(invocation, async assertInvocation => {
    const tool = assertInvocation().toolName;
    if (tool !== 'write' && tool !== 'pdf_to_markdown') return fail('TOOL_POLICY_DENIED');
    return withPreparedFixedDocumentToolPolicy(tool, operation);
  });
}

/** The public wrappers fix the operation; callers cannot select a policy,
 * provide an authorization reader or expand this private set. */
async function withPreparedFixedDocumentToolPolicy<T>(toolName: 'public_share_file' | 'search_documents' | 'edit_file' | 'write' | 'pdf_to_markdown',
  operation: (policy: Policy) => Promise<T>): Promise<T> {
  const invocation = captureCurrentAgentToolInvocation();
  return withCapturedAgentToolInvocation(invocation,async assertInvocation => {
    if (typeof operation !== 'function' || assertInvocation().toolName !== toolName) fail('TOOL_POLICY_DENIED');
    const handles: FileHandle[] = [], captures: ConfigCapture[] = [];
    const pending = new Set<Promise<void>>();
    let accepting = true, active = true, checking = false, failure: {error:unknown} | undefined;
    let outcome: {value:T} | undefined, primary: {error:unknown} | undefined;
    try {
      // This existing reader owns its private migration/default preparation.
      // It is intentionally never called by assertCurrent on SQL connection B.
      await readPiRuntimeConfig(); assertInvocation();
      for (const filePath of new Set([PI_RUNTIME_CONFIG_PATH,resolveLegacySettingsStoragePath(PI_RUNTIME_CONFIG_FILE)])) {
        captures.push(await captureConfig(filePath,handles)); assertInvocation();
      }
      const preparedMainConfig = await readPiRuntimeConfig();
      assertInvocation(); await assertConfig(captures); assertInvocation();
      const assertCurrent = (database: SqlConnection, access: WorkspaceAgentToolPrincipalAccess): Promise<void> => {
        const check = (async () => {
          try {
            if (!active || !accepting || checking || failure) fail('TOOL_POLICY_CHANGED');
            checking = true;
            const origin = assertInvocation();
            if (origin.toolName !== toolName || access.toolName !== toolName || access.toolCallId !== origin.toolCallId
              || access.userId !== origin.userId || access.agentId !== normalizeManagedAgentId(origin.agentId)
              || access.piSessionId !== origin.sessionId || access.workspace.workspaceId !== origin.workspaceId) fail('TOOL_POLICY_DENIED');
            await access.assertCurrent(); await assertConfig(captures); assertInvocation();
            const before = await readAgentProfileOnConnection(database,access.agentId);
            if (!before || before.agentId !== access.agentId) fail('TOOL_POLICY_DENIED');
            const configured = normalizeEnabledToolsConfig(resolveEffectiveProviderConfig(preparedMainConfig,before,
              access.agentId === DEFAULT_MANAGED_AGENT_ID ? 'main' : 'special').providerConfig.enabledTools);
            if (configured.includes(DISABLED_ALL_TOOLS_SENTINEL)) fail('TOOL_POLICY_DENIED');
            const names = [toolName];
            const enabled = isDefaultToolsConfig(configured) ? getDefaultEnabledToolNames(names) : resolveEnabledToolNames(names,configured);
            if (!enabled.has(toolName)) fail('TOOL_POLICY_DENIED');
            await assertConfig(captures);
            const after = await readAgentProfileOnConnection(database,access.agentId);
            if (!after || JSON.stringify(before) !== JSON.stringify(after)) fail('TOOL_POLICY_CHANGED');
            await access.assertCurrent(); await assertConfig(captures); assertInvocation();
            if (!active || failure) fail('TOOL_POLICY_CHANGED');
          } catch (error) { failure ??= {error}; throw error; }
          finally { checking = false; }
        })();
        pending.add(check);
        void check.then(() => pending.delete(check),() => pending.delete(check));
        return check;
      };
      try { outcome = {value:await operation(Object.freeze({assertCurrent}))}; }
      catch (error) { primary = {error}; }
      accepting = false;
      if (pending.size) {
        failure ??= {error:new PublicShareToolPolicyError('TOOL_POLICY_CHANGED')};
        await Promise.allSettled([...pending]);
      }
      if (!primary && failure) primary = failure;
      if (!primary) {
        await assertConfig(captures); assertInvocation();
        if (failure) primary = failure;
      }
    } catch (error) { primary ??= {error:error instanceof PublicShareToolPolicyError ? error : new PublicShareToolPolicyError('TOOL_POLICY_UNAVAILABLE')}; }
    finally {
      accepting = false; active = false;
      const closed = await Promise.allSettled(handles.map(async handle => handle.close()));
      const cleanup = closed.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (cleanup.length) primary = {error:new AggregateError([...(primary ? [primary.error] : []),...cleanup],
        'Public tool policy cleanup could not be confirmed.')};
    }
    if (primary) throw primary.error;
    return outcome!.value;
  });
}
