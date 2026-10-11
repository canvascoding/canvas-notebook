import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';

export const LIVE_MODEL_BASE = 'http://127.0.0.1:3001';
export const LIVE_MODEL_TOOL = 'CANVA_GET_USERS_ME_CAPABILITIES';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const CONNECTION = /^canvas-connection:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const MAX_BODY = 2 * 1024 * 1024;

export type LiveModelTarget = { scope: 'organization' | 'team'; connectionRef: string; workspaceId: string; profileId: string };
export type LiveModelHandoff = { version: 1; nonce: string; root: string; organizationId: string; actorId: string;
  targets: [LiveModelTarget, LiveModelTarget]; modelInputPath: string; inputSHA: string; recoverySHA: string };
export type LiveModelIdentity = { userId: string; authSessionHash: string; role: 'admin' | 'user' };
export type LiveModelMessage = { role: string; content?: string | Array<{ type?: string; id?: string; name?: string;
  arguments?: Record<string, unknown>; text?: string }>; toolName?: string; toolCallId?: string;
  isError?: boolean; details?: Record<string, unknown>; stopReason?: string };
export type LiveModelEffect = { scope: 'organization' | 'team'; connectionRef: string; workspaceId: string;
  toolName: typeof LIVE_MODEL_TOOL; toolCallId: string; providerRef: string; toolRef: string; schemaRef: string;
  toolVersion: string; inputSchemaSHA: string; responseSHA: string; successful: true };

export function liveModelRequire(value: unknown, phase: string): asserts value {
  if (!value) throw new Error(`Live Composio model ${phase} did not satisfy its contract.`);
}
export function liveModelRecord(value: unknown): Record<string, unknown> {
  liveModelRequire(value !== null && typeof value === 'object' && !Array.isArray(value), 'structured-value');
  return value as Record<string, unknown>;
}
export function liveModelHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Private input is read once with fd/path fences; neither its bytes nor filesystem errors are logged. */
export async function readLiveModelPrivateBytes(filename: string, maximum = 64 * 1024): Promise<Buffer> {
  try {
    const uid = process.getuid?.();
    liveModelRequire(uid !== undefined && path.isAbsolute(filename), 'private-input');
    const [before, parent, physical] = await Promise.all([fs.lstat(filename), fs.lstat(path.dirname(filename)), fs.realpath(filename)]);
    liveModelRequire(physical === filename && parent.isDirectory() && !parent.isSymbolicLink()
      && parent.uid === uid && (parent.mode & 0o777) === 0o700, 'private-input');
    liveModelRequire(before.isFile() && !before.isSymbolicLink() && before.uid === uid && before.nlink === 1
      && (before.mode & 0o777) === 0o600 && before.size > 0 && before.size <= maximum, 'private-input');
    const fd = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await fd.stat(), buffer = Buffer.alloc(maximum + 1);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      const snapshots: Stats[] = [opened, await fd.stat(), await fs.lstat(filename)];
      for (const current of snapshots) liveModelRequire(current.isFile() && !current.isSymbolicLink()
        && current.uid === uid && current.nlink === 1 && (current.mode & 0o777) === 0o600
        && current.dev === before.dev && current.ino === before.ino && current.size === before.size
        && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs, 'private-input');
      liveModelRequire(bytesRead === before.size && bytesRead <= maximum, 'private-input');
      return buffer.subarray(0, bytesRead);
    } finally { await fd.close(); }
  } catch { throw new Error('Live Composio model private input is invalid.'); }
}

export async function readComposioLiveModelHandoff(): Promise<LiveModelHandoff> {
  try {
    const inputPath = process.env.CANVAS_COMPOSIO_LIVE_MODEL_INPUT;
    liveModelRequire(inputPath && process.env.CANVAS_COMPOSIO_LIVE_MODEL_RUN === '1'
      && process.env.BASE_URL === LIVE_MODEL_BASE && process.env.E2E_EXTERNAL_SERVER === '1'
      && process.env.__NEXT_PROCESSED_ENV === 'true' && !process.env.COMPOSIO_BASE_URL
      && !process.env.CANVAS_INTEGRATION_BROWSER_FIXTURE_URL, 'entry');
    const bytes = await readLiveModelPrivateBytes(inputPath), input = liveModelRecord(JSON.parse(bytes.toString('utf8')));
    liveModelRequire(Object.keys(input).sort().join(',') === 'actorId,modelInputPath,nonce,organizationId,root,targets,version'
      && input.version === 1 && typeof input.nonce === 'string' && /^[a-f0-9]{32}$/u.test(input.nonce)
      && typeof input.root === 'string' && input.root === path.dirname(inputPath)
      && /^canvas-composio-live-model-[A-Za-z0-9]{6}$/u.test(path.basename(input.root))
      && typeof input.organizationId === 'string' && ID.test(input.organizationId)
      && typeof input.actorId === 'string' && ID.test(input.actorId), 'handoff');
    liveModelRequire(process.env.DATA === path.join(input.root, 'data') && process.env.TMPDIR === path.join(input.root, 'tmp')
      && process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE === path.join(input.root, 'recovery.json'), 'root');
    const recoveryBytes = await readLiveModelPrivateBytes(path.join(input.root, 'recovery.json'));
    const recovery = liveModelRecord(JSON.parse(recoveryBytes.toString('utf8')));
    const rootStat = await fs.lstat(input.root), marker = await readLiveModelPrivateBytes(path.join(input.root, '.fixture-owner'), 1024);
    liveModelRequire(recovery.fixtureRoot === input.root && recovery.nonce === input.nonce && recovery.actorId === input.actorId
      && recovery.createAcknowledged === true && recovery.listenerVerified === true && recovery.phase === 'browser'
      && recovery.dataRoot === process.env.DATA && recovery.tmpRoot === process.env.TMPDIR
      && recovery.repo === process.cwd() && recovery.rootDevice === String(rootStat.dev) && recovery.rootInode === String(rootStat.ino)
      && recovery.ownerMarker === marker.toString('utf8') && Number.isSafeInteger(recovery.serverPid)
      && Number(recovery.serverPid) > 0, 'recovery');
    liveModelRequire(Array.isArray(input.targets) && input.targets.length === 2, 'targets');
    const targets = input.targets.map(value => {
      const target = liveModelRecord(value);
      liveModelRequire(Object.keys(target).sort().join(',') === 'connectionRef,profileId,scope,workspaceId'
        && ['organization', 'team'].includes(String(target.scope)) && typeof target.connectionRef === 'string'
        && CONNECTION.test(target.connectionRef) && typeof target.workspaceId === 'string' && ID.test(target.workspaceId)
        && typeof target.profileId === 'string' && ID.test(target.profileId), 'target');
      return target as LiveModelTarget;
    });
    liveModelRequire(targets[0].scope === 'organization' && targets[1].scope === 'team'
      && targets[0].connectionRef !== targets[1].connectionRef && targets[0].profileId !== targets[1].profileId, 'targets');
    liveModelRequire(typeof input.modelInputPath === 'string' && path.isAbsolute(input.modelInputPath)
      && path.dirname(input.modelInputPath) === input.root && input.modelInputPath !== inputPath
      && input.modelInputPath !== process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE, 'model-input-path');
    // The existing model helper owns the secret schema and central scoped ENV write.
    return { version: 1, nonce: input.nonce, root: input.root, organizationId: input.organizationId, actorId: input.actorId,
      targets: targets as [LiveModelTarget, LiveModelTarget], modelInputPath: input.modelInputPath,
      inputSHA: liveModelHash(bytes), recoverySHA: liveModelHash(recoveryBytes) };
  } catch { throw new Error('Live Composio model handoff is invalid.'); }
}

/** Same-origin normal HTTP only. No redirects/retries or secret-bearing request/response errors escape. */
export async function liveModelApi<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  route: string, phase: string, options: { data?: unknown; workspaceId?: string; status?: number;
    envelope?: 'data' | 'top' | 'nullable' } = {}): Promise<T> {
  let status: number | undefined;
  try {
    liveModelRequire(route.startsWith('/api/') && !route.startsWith('//') && !route.includes('#'), 'http-path');
    const response = await request.fetch(route, { method, timeout: 60_000, maxRedirects: 0, maxRetries: 0,
      failOnStatusCode: false, ...(options.data === undefined ? {} : { data: options.data }),
      headers: { Origin: LIVE_MODEL_BASE, ...(options.workspaceId ? { 'x-canvas-workspace-id': options.workspaceId } : {}) } });
    try {
      status = response.status(); liveModelRequire(status === (options.status ?? 200), phase);
      const bytes = await response.body(); liveModelRequire(bytes.length <= MAX_BODY, phase);
      const payload: unknown = JSON.parse(bytes.toString('utf8'));
      if (options.envelope === 'nullable') return payload as T;
      const value = liveModelRecord(payload); liveModelRequire(value.success === true, phase);
      if (options.envelope === 'top') return value as T;
      liveModelRequire(value.data !== undefined, phase); return value.data as T;
    } finally { await response.dispose(); }
  } catch { throw new Error(`Live Composio model ${phase} failed${status === undefined ? '' : ` (HTTP ${status})`}.`); }
}

export async function readLiveModelIdentity(request: APIRequestContext, expected?: LiveModelIdentity): Promise<LiveModelIdentity> {
  const payload = liveModelRecord(await liveModelApi(request, 'GET', '/api/auth/get-session', 'identity', { envelope: 'nullable' }));
  const user = liveModelRecord(payload.user), session = liveModelRecord(payload.session);
  liveModelRequire(typeof user.id === 'string' && ID.test(user.id) && ['admin', 'user'].includes(String(user.role))
    && typeof session.id === 'string' && session.id.length > 0 && session.id.length <= 256, 'identity');
  const identity: LiveModelIdentity = { userId: user.id, role: user.role as 'admin' | 'user', authSessionHash: liveModelHash(session.id) };
  if (expected) liveModelRequire(JSON.stringify(identity) === JSON.stringify(expected), 'identity-current');
  return identity;
}

/** Verify the actual model transcript, keeping external response bytes only in RAM. */
export function verifyLiveModelTranscript(messages: LiveModelMessage[], handoff: LiveModelHandoff): {
  transcriptSHA: string; toolCallCount: number; effects: LiveModelEffect[]; protocol: Record<string, unknown>;
} {
  liveModelRequire(Array.isArray(messages) && messages.length > 0 && messages.length <= 200
    && Buffer.byteLength(JSON.stringify(messages)) <= MAX_BODY, 'transcript-bound');
  const calls: Array<{ index: number; id: string; name: string; arguments: Record<string, unknown> }> = [];
  const results: Array<{ index: number; message: LiveModelMessage }> = [];
  messages.forEach((message, index) => {
    if (message.role === 'toolResult') {
      liveModelRequire(message.isError !== true && !message.details?.error && !message.details?.integrationError, 'tool-error');
      results.push({ index, message });
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) for (const block of message.content) if (block.type === 'toolCall') {
      liveModelRequire(block.name === 'integrations' && typeof block.id === 'string' && block.id.length > 0
        && block.id.length <= 256, 'tool-call');
      calls.push({ index, id: block.id, name: block.name, arguments: liveModelRecord(block.arguments) });
    }
  });
  liveModelRequire(calls.length >= 7 && calls.length <= 32 && new Set(calls.map(call => call.id)).size === calls.length
    && results.length === calls.length && messages.some(message => message.role === 'assistant' && message.stopReason === 'stop'), 'turn-complete');
  const paired = calls.map(call => {
    const matches = results.filter(result => result.message.toolCallId === call.id && result.message.toolName === call.name);
    liveModelRequire(matches.length === 1 && matches[0].index > call.index, 'paired-result');
    const result = matches[0], details = liveModelRecord(result.message.details), integration = liveModelRecord(details.integrations);
    liveModelRequire(integration.version === 1 && integration.action === call.arguments.action, 'result-receipt');
    return { call, result, details, integration };
  });
  const providerRows = paired.filter(pair => pair.call.arguments.action === 'list' && pair.call.arguments.target === 'providers');
  liveModelRequire(providerRows.length > 0, 'provider-discovery');
  const effects: LiveModelEffect[] = [];
  const descriptionIndexes: number[] = [], businessIndexes: number[] = [];
  for (const target of handoff.targets) {
    const candidates = providerRows.flatMap(pair => {
      liveModelRequire(pair.details.version === 1 && pair.details.target === 'providers' && Array.isArray(pair.details.providers)
        && Array.isArray(pair.details.providerErrors) && pair.details.providerErrors.length === 0, 'provider-page');
      return pair.details.providers.map(provider => ({ provider: liveModelRecord(provider), resultIndex: pair.result.index }));
    }).filter(({ provider }) => liveModelRecord(provider.scope).resourceId === target.connectionRef);
    liveModelRequire(candidates.length > 0, 'exact-provider');
    const selected = candidates[0], provider = selected.provider, scope = liveModelRecord(provider.scope);
    liveModelRequire(provider.source === 'composio' && provider.application === 'canva' && provider.state === 'ready'
      && provider.canExecute === true && provider.configured === true && provider.authorized === true
      && typeof provider.providerRef === 'string' && provider.providerRef.length <= 256
      && scope.organizationId === handoff.organizationId
      && scope.type === (target.scope === 'team' ? 'workspace' : 'organization')
      && (target.scope !== 'team' || scope.workspaceId === target.workspaceId), 'provider-scope');
    liveModelRequire(candidates.every(candidate => candidate.provider.providerRef === provider.providerRef), 'provider-stable');
    const lists = paired.filter(pair => pair.call.arguments.action === 'list' && pair.call.arguments.target === 'tools'
      && pair.call.arguments.providerRef === provider.providerRef && pair.call.index > selected.resultIndex);
    liveModelRequire(lists.length > 0, 'tools-discovery');
    const tools = lists.flatMap(pair => {
      liveModelRequire(pair.details.providerRef === provider.providerRef && pair.details.target === 'tools'
        && Array.isArray(pair.details.tools) && Array.isArray(pair.details.providerErrors) && pair.details.providerErrors.length === 0, 'tools-page');
      return pair.details.tools.map(tool => ({ tool: liveModelRecord(tool), resultIndex: pair.result.index }));
    }).filter(({ tool }) => tool.name === LIVE_MODEL_TOOL);
    liveModelRequire(tools.length > 0 && tools.every(entry => entry.tool.toolRef === tools[0].tool.toolRef), 'exact-tool');
    const tool = tools[0]; liveModelRequire(tool.tool.providerRef === provider.providerRef && typeof tool.tool.toolRef === 'string'
      && tool.tool.toolRef.length <= 256, 'tool-ref');
    const descriptions = paired.filter(pair => pair.call.arguments.action === 'describe'
      && pair.call.arguments.toolRef === tool.tool.toolRef && pair.call.index > tool.resultIndex);
    liveModelRequire(descriptions.length > 0, 'current-description');
    const description = descriptions[descriptions.length - 1], schema = description.details;
    liveModelRequire(schema.version === 1 && schema.toolRef === tool.tool.toolRef && schema.providerRef === provider.providerRef
      && typeof schema.schemaRef === 'string' && schema.schemaRef.length > 0 && schema.schemaRef.length <= 256
      && typeof schema.toolVersion === 'string' && schema.toolVersion.length > 0 && schema.toolVersion !== 'latest'
      && schema.toolVersion.length <= 128 && schema.inputSchema !== null && typeof schema.inputSchema === 'object'
      && !Array.isArray(schema.inputSchema), 'current-schema');
    const business = paired.filter(pair => pair.call.arguments.action === 'call' && pair.call.arguments.toolRef === tool.tool.toolRef);
    liveModelRequire(business.length === 1, 'once-per-scope');
    const effect = business[0], args = liveModelRecord(effect.call.arguments.arguments);
    liveModelRequire(effect.call.index > description.result.index && effect.call.arguments.schemaRef === schema.schemaRef
      && Object.keys(args).length === 0 && effect.integration.source === 'composio'
      && effect.integration.providerRef === provider.providerRef && effect.integration.toolRef === tool.tool.toolRef
      && effect.integration.schemaRef === undefined, 'current-call');
    descriptionIndexes.push(description.result.index); businessIndexes.push(effect.call.index);
    const content = effect.result.message.content;
    const textBlocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
    liveModelRequire(textBlocks.length === 1 && textBlocks[0].type === 'text' && typeof textBlocks[0].text === 'string'
      && Buffer.byteLength(textBlocks[0].text) <= MAX_BODY && !effect.details.proposal && !effect.details.toolOutputRead, 'complete-provider-result');
    const response = liveModelRecord(JSON.parse(textBlocks[0].text));
    liveModelRequire(response.successful === true && (response.error === undefined || response.error === null)
      && response.data !== undefined, 'provider-success');
    effects.push({ scope: target.scope, connectionRef: target.connectionRef, workspaceId: handoff.targets[1].workspaceId,
      toolName: LIVE_MODEL_TOOL, toolCallId: effect.call.id, providerRef: provider.providerRef,
      toolRef: tool.tool.toolRef, schemaRef: schema.schemaRef, toolVersion: schema.toolVersion,
      inputSchemaSHA: liveModelHash(JSON.stringify(schema.inputSchema)), responseSHA: liveModelHash(textBlocks[0].text), successful: true });
  }
  liveModelRequire(paired.filter(pair => pair.call.arguments.action === 'call').length === 2
    && effects[0].providerRef !== effects[1].providerRef && effects[0].toolRef !== effects[1].toolRef
    && effects[0].schemaRef !== effects[1].schemaRef
    && Math.max(...descriptionIndexes) < Math.min(...businessIndexes), 'two-distinct-scopes');
  const transcriptSHA = liveModelHash(JSON.stringify(messages));
  const operations = paired.map(pair => {
    const args = pair.call.arguments, action = String(args.action);
    liveModelRequire(['list', 'search', 'describe', 'call'].includes(action)
      && Object.keys(args).every(key => ['version', 'action', 'target', 'providerRef', 'toolRef', 'schemaRef', 'arguments',
        'cursor', 'limit', 'source', 'state', 'application', 'pluginRef', 'capabilityRef', 'query'].includes(key)), 'protocol-arguments');
    const effect = effects.find(value => value.toolCallId === pair.call.id);
    return { index: pair.call.index, toolCallId: pair.call.id, arguments: args,
      result: { index: pair.result.index, version: 1, action,
        ...(['source', 'providerRef', 'toolRef', 'schemaRef'] as const).reduce<Record<string, unknown>>((fields, key) => {
          if (pair.integration[key] !== undefined) fields[key] = pair.integration[key]; return fields;
        }, {}), ...(effect ? { successful: true, responseSHA: effect.responseSHA } : {}) },
      ...(Array.isArray(pair.details.providers) ? { providers: pair.details.providers.map(value => {
        const provider = liveModelRecord(value);
        return { providerRef: provider.providerRef, source: provider.source, application: provider.application,
          scope: provider.scope, state: provider.state, canExecute: provider.canExecute,
          configured: provider.configured, authorized: provider.authorized };
      }) } : {}),
      ...(Array.isArray(pair.details.tools) ? { tools: pair.details.tools.map(value => {
        const tool = liveModelRecord(value); return { name: tool.name, toolRef: tool.toolRef, providerRef: tool.providerRef };
      }) } : {}),
      ...(action === 'describe' ? { schema: { version: pair.details.version, toolRef: pair.details.toolRef,
        providerRef: pair.details.providerRef, schemaRef: pair.details.schemaRef, toolVersion: pair.details.toolVersion,
        inputSchema: pair.details.inputSchema } } : {}),
    };
  });
  return { transcriptSHA, toolCallCount: calls.length, effects, protocol: { version: 1, transcriptSHA,
    toolCallCount: calls.length, toolErrors: 0, providerResponsesPersisted: false, operations } };
}

export async function writeLiveModelArtifact(root: string, name: string, value: unknown): Promise<{ relative: string; sha256: string }> {
  liveModelRequire(/^[a-z0-9][a-z0-9.-]{0,99}$/u.test(name), 'artifact-name');
  const bytes = JSON.stringify(value); liveModelRequire(Buffer.byteLength(bytes) <= 256 * 1024, 'artifact-bound');
  const relative = `live-composio-model-evidence/${name}`;
  await fs.writeFile(path.join(root, relative), bytes, { flag: 'wx', mode: 0o600 });
  return { relative, sha256: liveModelHash(bytes) };
}
