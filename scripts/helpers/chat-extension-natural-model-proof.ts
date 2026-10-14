import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { extensionPackagePinSchema } from '../../app/lib/capabilities/extensions/contracts';
import { parseChatBody } from '../../app/lib/chat/chat-body-contracts';
import type { StoredAcceptedChatMessage } from '../../app/lib/chat/durable-message-contracts';
import type { AiSessionRuntimeSnapshot } from '../../app/lib/agent-runtime-policy/types';

export type ChatExtensionNaturalModelFixture = {
  root: string; nonce: string; actorId: string; dataRoot: string; databaseName: string; baseURL: string;
  mcpUrl: string; mcpSpki: string;
};
const identifier = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const relativeRoot = z.string().max(1_024).refine(value => value === '' || value.split('/').every(part =>
  part && part !== '.' && part !== '..' && !/[\\:\p{Cc}\p{Cf}]/u.test(part)));
const caseSchema = z.object({
  kind: z.enum(['natural_discovery', 'inline_plugin']), sessionId: identifier, agentId: identifier, workspaceId: identifier,
  clientMessageId: identifier, serverMessageId: z.string().uuid(), packagePin: extensionPackagePinSchema,
  expectedSkill: z.object({ relativeRoot, sha256: sha }).strict(), readToolCallIds: z.array(identifier).min(1).max(32),
  contentSHA256: sha, bodySHA256: sha.optional(), discoveryToolCallId: identifier.optional(),
  describeToolCallId: identifier.optional(), callToolCallId: identifier.optional(),
  connectionRef: z.string().regex(/^mcp-personal:[a-f0-9-]{36}$/u).optional(),
}).strict().superRefine((value, context) => {
  const fields = value.kind === 'natural_discovery' ? ['discoveryToolCallId'] as const
    : ['describeToolCallId', 'callToolCallId', 'connectionRef', 'bodySHA256'] as const;
  for (const field of fields) if (!value[field]) context.addIssue({ code: 'custom', path: [field], message: 'Evidence is required for this case.' });
  if (new Set(value.readToolCallIds).size !== value.readToolCallIds.length) context.addIssue({ code: 'custom', message: 'Read evidence must use distinct call IDs.' });
});
export const chatExtensionNaturalModelProofSchema = z.object({
  version: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{32}$/u), actorId: identifier,
  model: z.object({ providerInstallationId: identifier, providerId: z.literal('ollama'), modelId: z.literal('kimi-k2.6:cloud'),
    thinkingLevel: z.literal('off'), credentialScope: z.literal('organization') }).strict(),
  gateway: z.object({ integrationToolGatewayEnabled: z.literal(true), updatedAt: z.string().datetime().nullable() }).strict(),
  cases: z.array(caseSchema).length(2), externalLlm: z.literal(true), controlledConnectors: z.literal(true),
  literalResolvedPathObserved: z.literal(false), runtimeErrors: z.literal(0), forbiddenUiCalls: z.literal(0),
}).strict();
export type ChatExtensionNaturalModelProof = z.infer<typeof chatExtensionNaturalModelProofSchema>;
type Case = ChatExtensionNaturalModelProof['cases'][number];
type RecordValue = Record<string, unknown>;
type Message = RecordValue & { role: string; content?: unknown; toolName?: string; toolCallId?: string; details?: unknown };
type ToolCall = { id: string; name: string; arguments: RecordValue; messageIndex: number };
type Transcript = { messages: Message[]; calls: ToolCall[] };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown) => hash(JSON.stringify(left)) === hash(JSON.stringify(right));
function record(value: unknown): RecordValue {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'A structured server evidence object is required.');
  return value as RecordValue;
}
function text(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  assert(Array.isArray(message.content), 'A text-bearing server message is required.');
  return message.content.flatMap(value => { const block = record(value); return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []; }).join('\n');
}

/** Bounded, inode-stable reads; neither proof JSON nor published content may select an arbitrary host path. */
async function ownedBytes(filePath: string, options: { private?: boolean; maxBytes?: number } = {}): Promise<Buffer> {
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    assert(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.() && before.size > 0
      && before.size <= (options.maxBytes ?? 2 * 1024 * 1024)
      && (!options.private || (before.mode & 0o777) === 0o600), 'Owned evidence file bounds or ownership changed.');
    const bytes = await file.readFile();
    assert.equal(bytes.length, before.size, 'Owned evidence changed while reading.');
    for (const after of [await file.stat(), await fs.lstat(filePath)]) assert(after.isFile() && !after.isSymbolicLink()
      && after.nlink === 1 && after.uid === before.uid && after.mode === before.mode && after.dev === before.dev
      && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
    'Owned evidence changed while reading.');
    return bytes;
  } finally { await file.close(); }
}

function revisionMetadata(value: unknown) {
  const canonical = typeof value === 'number' || typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/u.test(value);
  const number = canonical ? Number(value) : NaN;
  const valid = canonical && Number.isSafeInteger(number) && number >= 0;
  return { type: value === null ? 'null' : typeof value, valid, value: valid ? number : null };
}
function exactRevision(value: unknown, positive = false): number {
  const metadata = revisionMetadata(value);
  assert(metadata.valid && metadata.value !== null && (!positive || metadata.value > 0), 'An exact canonical runtime revision is required.');
  return metadata.value;
}

/** Safe metadata only; unexpected strings, prompts, credentials and paths are never written. */
async function writeSessionModelDiagnostic(fixture: ChatExtensionNaturalModelFixture, run: Case, model: ChatExtensionNaturalModelProof['model'],
  session: RecordValue, catalog: RecordValue | undefined, policy: RecordValue | undefined) {
  const field = (value: unknown, expected: string, id = false) => ({ type: value === null ? 'null' : typeof value,
    matchesExpected: value === expected, ...(id ? { sha256: typeof value === 'string' && value.length <= 256 ? hash(value) : null } : {}) });
  const diagnostic = Buffer.from(JSON.stringify({ version: 1, kind: run.kind,
    session: { provider: field(session.provider, model.providerId), model: field(session.model, model.modelId),
      thinking: field(session.thinking_level, 'off'), installation: field(session.runtime_provider_installation_id, model.providerInstallationId, true),
      source: field(session.runtime_selection_source, 'app_default'), catalogRevision: revisionMetadata(session.runtime_catalog_revision),
      policyRevision: revisionMetadata(session.runtime_policy_revision) },
    catalog: { exists: Boolean(catalog), provider: field(catalog?.provider_id, model.providerId), model: field(catalog?.model_id, model.modelId),
      thinking: field(catalog?.thinking_level, 'off'), installation: field(catalog?.provider_installation_id, model.providerInstallationId, true),
      revision: revisionMetadata(catalog?.catalog_revision) },
    workspacePolicy: { exists: Boolean(policy), revision: policy ? revisionMetadata(policy.revision) : { missingPolicyRevision: 0 } },
  }));
  assert(diagnostic.length <= 4096);
  const before = await fs.lstat(fixture.root), receipt = record(JSON.parse((await ownedBytes(path.join(fixture.root, 'recovery.json'), { private: true, maxBytes: 65_536 })).toString('utf8')));
  assert(before.isDirectory() && !before.isSymbolicLink() && before.uid === process.getuid?.() && (before.mode & 0o777) === 0o700
    && await fs.realpath(fixture.root) === fixture.root && receipt.nonce === fixture.nonce && receipt.fixtureRoot === fixture.root
    && receipt.rootDevice === String(before.dev) && receipt.rootInode === String(before.ino));
  const filePath = path.join(fixture.root, `chat-extension-model-metadata-${run.kind}.json`);
  const file = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const created = await file.stat();
    assert(created.isFile() && created.uid === before.uid && created.nlink === 1 && (created.mode & 0o777) === 0o600);
    await file.writeFile(diagnostic);
    const after = await fs.lstat(fixture.root), current = await fs.lstat(filePath);
    assert(after.isDirectory() && after.dev === before.dev && after.ino === before.ino && after.uid === before.uid && after.mode === before.mode
      && current.isFile() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino
      && current.uid === created.uid && current.nlink === 1 && current.mode === created.mode && current.size === diagnostic.length);
  } finally { await file.close(); }
}

async function assertOwnedFixture(fixture: ChatExtensionNaturalModelFixture) {
  assert.match(fixture.nonce, /^[a-f0-9]{32}$/u); assert(identifier.safeParse(fixture.actorId).success);
  assert(path.isAbsolute(fixture.root) && await fs.realpath(fixture.root) === fixture.root);
  const stat = await fs.lstat(fixture.root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
  assert.equal(fixture.dataRoot, path.join(fixture.root, 'data')); assert.equal(await fs.realpath(fixture.dataRoot), fixture.dataRoot);
  assert.equal(process.env.DATA, fixture.dataRoot); assert.equal(process.env.CANVAS_DATA_ROOT, fixture.dataRoot);
  assert.equal(process.env.PLUGIN_EXTENSION_E2E_ROOT, fixture.root); assert.equal(process.env.PLUGIN_EXTENSION_E2E_NONCE, fixture.nonce);
  assert.equal(fixture.databaseName, `canvas_plugin_extension_test_${fixture.nonce}`);
  assert.equal(fixture.baseURL, 'http://127.0.0.1:3001'); assert.equal(process.env.BASE_URL, fixture.baseURL);
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port === '55433'
    && !url.search && !url.hash); assert.equal(url.pathname, `/${fixture.databaseName}`);
  const marker = (await ownedBytes(path.join(fixture.root, '.fixture-owner'), { private: true, maxBytes: 48 })).toString('utf8');
  assert.match(marker, /^[a-f0-9]{48}$/u);
  const receipt = record(JSON.parse((await ownedBytes(path.join(fixture.root, 'recovery.json'), { private: true, maxBytes: 65_536 })).toString('utf8')));
  assert.equal(receipt.nonce, fixture.nonce); assert.equal(receipt.actorId, fixture.actorId); assert.equal(receipt.fixtureRoot, fixture.root);
  assert.equal(receipt.dataRoot, fixture.dataRoot); assert.equal(receipt.databaseName, fixture.databaseName); assert.equal(receipt.ownerMarker, marker);
  assert(receipt.createAcknowledged === true && receipt.databaseDropped === false && receipt.uncertain === false);
  assert.equal(receipt.rootDevice, String(stat.dev)); assert.equal(receipt.rootInode, String(stat.ino));
  const mcp = new URL(fixture.mcpUrl), tls = record(receipt.mcpTls);
  assert(mcp.protocol === 'https:' && mcp.hostname === '127.0.0.1' && !mcp.username && !mcp.password && !mcp.search && !mcp.hash);
  assert.equal(tls.origin, mcp.origin); assert.equal(tls.spki, fixture.mcpSpki);
  const { openDb } = await import('../../app/lib/db'); const database = await openDb();
  try {
    const identity = record(await database.get('SELECT current_database() AS name,current_user AS role'));
    assert.equal(identity.name, fixture.databaseName);
    const owner = record(await database.get("SELECT pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [fixture.databaseName]));
    assert.equal(owner.owner, identity.role); assert.equal(owner.marker, marker);
    const actor = record(await database.get('SELECT id,role FROM "user" WHERE id=$1', [fixture.actorId]));
    assert.equal(actor.id, fixture.actorId); assert.equal(actor.role, 'admin');
  } finally { await database.close(); }
}

async function publishedSkill(fixture: ChatExtensionNaturalModelFixture, run: Case) {
  const { findCapabilityResourceRecord, withAuthorizedCapabilityPackageResource } = await import('../../app/lib/capabilities/resources/store');
  const { getCapabilityPackagePublishedRevision } = await import('../../app/lib/capabilities/packages/store');
  const { resolveOwnerScopedPackageVersionPath, verifyCapabilityPackageSnapshot } = await import('../../app/lib/capabilities/packages/io');
  const source = await findCapabilityResourceRecord(run.packagePin.resourceRef); assert(source, 'The actual published resource is required.');
  assert.equal(source.storage.resourceType, run.kind === 'natural_discovery' ? 'skill' : 'plugin');
  return withAuthorizedCapabilityPackageResource({ userId: fixture.actorId, workspaceId: run.workspaceId }, source.storage, 'use', undefined,
    async (authorization, database) => {
      const published = await getCapabilityPackagePublishedRevision(run.packagePin.resourceRef, run.packagePin.publishedRevisionRef, database);
      assert(published && published.checksum === run.packagePin.checksum, 'The exact published revision must match the selected pin.');
      const location = { ...published, owner: authorization.record.metadata.ownership,
        rootPath: resolveOwnerScopedPackageVersionPath({ ...published, owner: authorization.record.metadata.ownership }) };
      await verifyCapabilityPackageSnapshot(location);
      const relative = run.expectedSkill.relativeRoot ? `${run.expectedSkill.relativeRoot}/SKILL.md` : 'SKILL.md';
      const entry = published.files.find(file => file.path === relative); assert(entry, 'The skill must be present in this exact immutable package.');
      const bytes = await ownedBytes(path.join(location.rootPath, relative));
      assert(bytes.length === entry.size && hash(bytes) === entry.checksum && entry.checksum === run.expectedSkill.sha256,
        'The complete immutable skill bytes must agree with the published inventory and browser checksum.');
      assert(bytes.toString('utf8').includes(fixture.nonce.slice(0, 10)), 'The skill must contain this fixture nonce prefix, preventing a same-caption/source substitute.');
      return { bytes, relative, name: published.name, sha256: entry.checksum };
    });
}

function transcript(rows: Array<{ content: string; sequence: number | string }>): Transcript {
  assert(rows.length > 0 && rows.length <= 128, 'The two isolated single-turn histories must remain bounded.');
  const calls: ToolCall[] = [], messages = rows.map((row, index) => {
    assert.equal(Number(row.sequence), index + 1, 'The actual history sequence must be contiguous.');
    const value = record(JSON.parse(row.content)); assert(typeof value.role === 'string'); return value as Message;
  });
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    for (const value of message.content) { const block = record(value); if (block.type !== 'toolCall') continue;
      assert(typeof block.id === 'string' && typeof block.name === 'string');
      calls.push({ id: block.id, name: block.name, arguments: record(block.arguments), messageIndex });
    }
  });
  assert.equal(new Set(calls.map(call => call.id)).size, calls.length, 'Each actual tool call must have one identity.');
  return { messages, calls };
}
function pair(history: Transcript, id: string, name: string) {
  const calls = history.calls.filter(call => call.id === id && call.name === name); assert.equal(calls.length, 1, 'One matching actual assistant tool call is required.');
  const results = history.messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'toolResult' && message.toolCallId === id && message.toolName === name);
  assert.equal(results.length, 1, 'One matching actual tool result is required.');
  const result = results[0]; assert(result.index > calls[0].messageIndex && result.message.isError !== true, 'The successful tool result must follow its actual call.');
  const details = record(result.message.details);
  assert(!details.error && !details.integrationError, 'The selected proof chain must contain successful server results.');
  return { call: calls[0], result: result.message, details, resultIndex: result.index };
}

/** Check actual returned windows, not a model-supplied SHA claim or a displayed excerpt. */
async function verifyRead(history: Transcript, run: Case, expected: Buffer) {
  const source = expected.toString('utf8'), windows: Array<{ offset: number; end: number }> = [];
  let firstCallIndex = Infinity, lastResultIndex = -1;
  for (const id of run.readToolCallIds) {
    const paired = pair(history, id, 'read');
    // Persisted raw output can be larger than the actual model view. Full
    // archived bytes alone must never be presented as bytes delivered to it.
    const view: RecordValue | null = paired.details.toolOutputView ? record(paired.details.toolOutputView) : null;
    const details = view && view.readDetails ? { ...paired.details, ...record(view.readDetails) } : paired.details;
    const returnedText = view ? (assert(typeof view.text === 'string'), view.text) : text(paired.result);
    assert(details.type === 'text' && details.sha256 === hash(expected) && details.size === expected.length
      && details.textLength === source.length && details.totalChars === source.length, 'Read metadata must match the complete immutable file.');
    const offset = details.offset, end = details.nextOffset, layout = record(details.toolOutputReadWindow);
    assert(typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 && typeof end === 'number'
      && Number.isSafeInteger(end) && end > offset && end <= source.length && details.eof === (end === source.length));
    const start = layout.bodyStart, finish = layout.bodyEnd;
    assert(typeof start === 'number' && Number.isSafeInteger(start) && start >= 0 && typeof finish === 'number'
      && Number.isSafeInteger(finish) && finish >= start && finish <= returnedText.length);
    assert(Buffer.from(returnedText.slice(start, finish), 'utf8').equals(Buffer.from(source.slice(offset, end), 'utf8')),
      'Actual returned read bytes must match this exact published source window.');
    windows.push({ offset, end }); firstCallIndex = Math.min(firstCallIndex, paired.call.messageIndex); lastResultIndex = Math.max(lastResultIndex, paired.resultIndex);
  }
  let covered = 0; for (const window of windows.sort((a, b) => a.offset - b.offset)) { assert(window.offset <= covered, 'The observed read windows must leave no gaps.'); covered = Math.max(covered, window.end); }
  assert.equal(covered, source.length, 'All immutable source bytes must actually have been returned.');
  return { firstCallIndex, lastResultIndex, byteLength: expected.length, completeReadBytesVerified: true };
}

async function verifyCase(fixture: ChatExtensionNaturalModelFixture, proof: ChatExtensionNaturalModelProof, run: Case) {
  const { DEFAULT_MANAGED_AGENT_ID } = await import('../../app/lib/agents/storage');
  assert.equal(run.agentId, DEFAULT_MANAGED_AGENT_ID, 'Both cases require the genuine general agent, not a renamed specialist.');
  const { openDb } = await import('../../app/lib/db');
  const { readOwnedAcceptedChatMessage, readOwnedChatMessageExecutionSnapshot } = await import('../../app/lib/pi/durable-message-admission');
  const { readPiSessionRuntimeSnapshot } = await import('../../app/lib/agent-runtime-policy/runtime-store');
  const { canonicalAcceptedMessageIntentHash } = await import('../../app/lib/chat/durable-message-contracts');
  const identity = { userId: fixture.actorId, sessionId: run.sessionId, clientMessageId: run.clientMessageId,
    expectedAgentId: run.agentId, expectedWorkspaceId: run.workspaceId };
  const deadline = performance.now() + 15_000;
  let owned = await readOwnedAcceptedChatMessage(identity); assert(owned, 'A genuine currently Use-authorized accepted row is required.');
  let snapshot = readOwnedChatMessageExecutionSnapshot(owned);
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);
  // turn_end history can commit before agent_end settles its execution CAS.
  // Re-read only this exact original row; never claim, dispatch or retry it.
  while (!terminal.has(snapshot.phase) && performance.now() < deadline) {
    assert.equal(snapshot.payload.serverMessageId, run.serverMessageId);
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(0, deadline - performance.now()))));
    owned = await readOwnedAcceptedChatMessage(identity); assert(owned, 'The original currently Use-authorized accepted row must remain available.');
    snapshot = readOwnedChatMessageExecutionSnapshot(owned);
  }
  const payload = snapshot.payload;
  assert.equal(payload.serverMessageId, run.serverMessageId);
  assert(snapshot.phase === 'succeeded' && snapshot.executionRevision >= 4 && snapshot.runtimeToken !== 'unclaimed', 'The actual accepted execution must have succeeded.');
  const database = await openDb();
  let history: Transcript;
  let expectedModelSnapshot: AiSessionRuntimeSnapshot | null = null;
  try {
    const session = record(await database.get(`SELECT s.*,w.owner_user_id,w.status AS workspace_status
      FROM pi_sessions s JOIN canvas_workspaces w ON w.id=s.workspace_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.session_id=$3 AND s.agent_id=$4 AND s.workspace_id=$5`,
    [snapshot.sessionDbId, fixture.actorId, run.sessionId, run.agentId, run.workspaceId]));
    assert(session.archived_at === null && session.workspace_type === 'personal' && session.owner_user_id === fixture.actorId && session.workspace_status === 'active');
    const catalog = await database.get(`SELECT provider_installation_id,provider_id,model_id,thinking_level,catalog_revision
      FROM ai_runtime_defaults WHERE organization_id=$1`, [session.organization_id]) as RecordValue | undefined;
    const policy = await database.get('SELECT revision FROM ai_workspace_model_policies WHERE organization_id=$1 AND workspace_id=$2',
      [session.organization_id, run.workspaceId]) as RecordValue | undefined;
    await writeSessionModelDiagnostic(fixture, run, proof.model, session, catalog, policy);
    assert(session.provider === proof.model.providerId && session.model === proof.model.modelId && session.thinking_level === 'off'
      && session.runtime_provider_installation_id === proof.model.providerInstallationId && session.runtime_selection_source === 'app_default',
    'The actual session must pin the verified external model and retain its app-default inheritance.');
    const catalogRevision = exactRevision(session.runtime_catalog_revision, true), policyRevision = exactRevision(session.runtime_policy_revision);
    assert(catalog && catalog.provider_installation_id === proof.model.providerInstallationId && catalog.provider_id === proof.model.providerId
      && catalog.model_id === proof.model.modelId && catalog.thinking_level === 'off', 'The genuine current app default must match the exact session model.');
    assert.equal(catalogRevision, exactRevision(catalog.catalog_revision, true), 'The session must retain the genuine catalog revision.');
    assert.equal(policyRevision, policy ? exactRevision(policy.revision) : 0, 'The session policy revision must equal the genuine workspace policy; no policy means revision zero.');
    expectedModelSnapshot = { selection: { providerInstallationId: proof.model.providerInstallationId, providerId: proof.model.providerId,
      modelId: proof.model.modelId, thinkingLevel: 'off' }, catalogRevision, policyRevision, selectionSource: 'app_default' };
    const installation = record(await database.get('SELECT * FROM ai_provider_installations WHERE id=$1 AND organization_id=$2',
      [proof.model.providerInstallationId, session.organization_id]));
    assert(installation.provider_id === 'ollama' && installation.credential_scope === 'organization' && Number(installation.enabled) === 1
      && installation.status === 'ready' && installation.verified_at !== null, 'The genuine model catalog installation must be verified and ready.');
    const config = record(JSON.parse(String(installation.config_json)));
    assert(config.ollamaHost === 'http://127.0.0.1:11434', 'The model endpoint must be the real local Ollama service, never the controlled completion fixture.');
    const receipts = await database.all('SELECT client_message_id,payload_hash,private_payload FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1', [snapshot.sessionDbId]) as Array<{ client_message_id: string; payload_hash: string; private_payload: string }>;
    assert.equal(receipts.length, 1, 'Each actual case admits exactly one original user message.');
    assert.equal(receipts[0].client_message_id, run.clientMessageId);
    assert(same(JSON.parse(receipts[0].private_payload), payload), 'The genuine Owned data must equal the actual stored payload.');
    assert.equal(receipts[0].payload_hash, canonicalAcceptedMessageIntentHash({ content: payload.message.content, context: payload.context,
      mode: payload.mode, selection: payload.extensionSelection?.publicSelection ?? null, ...(payload.body === undefined ? {} : { body: payload.body }) }));
    const rows = await database.all('SELECT content,sequence FROM pi_messages WHERE pi_session_db_id=$1 ORDER BY sequence,id LIMIT 129', [snapshot.sessionDbId]) as Array<{ content: string; sequence: number }>;
    history = transcript(rows);
    const usage = record(await database.get(`SELECT COUNT(*) AS count,SUM(total_tokens) AS tokens FROM pi_usage_events
      WHERE user_id=$1 AND session_id=$2 AND agent_id=$3 AND workspace_id=$4 AND provider='ollama' AND model='kimi-k2.6:cloud'`,
    [fixture.actorId, run.sessionId, run.agentId, run.workspaceId]));
    assert(Number(usage.count) > 0 && Number(usage.tokens) > 0, 'Actual model usage must be persisted for this exact session.');
  } finally { await database.close(); }
  assert(expectedModelSnapshot);
  assert.deepEqual(await readPiSessionRuntimeSnapshot({ sessionId: run.sessionId, userId: fixture.actorId, agentId: run.agentId }),
    expectedModelSnapshot, 'The genuine stored-session reader must preserve the exact selection, revisions and inheritance source.');
  assertOriginal(payload, history, run, fixture.actorId);
  const skill = await publishedSkill(fixture, run), reads = await verifyRead(history, run, skill.bytes);
  if (run.kind === 'natural_discovery') verifyDiscovery(history, run, payload, skill.name, reads.firstCallIndex);
  else await verifyIntegration(fixture, history, run, payload, reads.lastResultIndex);
  const after = await readOwnedAcceptedChatMessage(identity); assert(after, 'The original actor must retain current Session/Agent Use.');
  assert(same(readOwnedChatMessageExecutionSnapshot(after), snapshot), 'Parent verification must never mutate or replace the original accepted execution.');
  return { kind: run.kind, sessionHash: hash(run.sessionId), messageHash: hash(run.serverMessageId),
    package: run.packagePin, skillSHA256: skill.sha256, skillBytes: reads.byteLength, completeReadBytesVerified: true, literalResolvedPathObserved: false };
}

function assertOriginal(payload: StoredAcceptedChatMessage, history: Transcript, run: Case, actorId: string) {
  assert(payload.identity.userId === actorId && payload.identity.sessionId === run.sessionId && payload.identity.agentId === run.agentId
    && payload.identity.workspaceId === run.workspaceId && payload.serverMessageId === run.serverMessageId && payload.clientMessageId === run.clientMessageId);
  assert.equal(hash(JSON.stringify(payload.message.content)), run.contentSHA256, 'The exact original submitted content must be preserved.');
  assert.equal(payload.body === undefined ? undefined : hash(JSON.stringify(parseChatBody(payload.body))), run.bodySHA256,
    'The exact original inline body must be preserved.');
  const users = history.messages.filter(message => message.role === 'user'); assert.equal(users.length, 1);
  assert(users[0].clientMessageId === run.clientMessageId && users[0].serverMessageId === run.serverMessageId
    && users[0].timestamp === payload.message.timestamp && same(users[0].content, payload.message.content)
    && same(users[0].body ?? null, payload.body ?? null), 'SQL history must contain exactly the original accepted identity, content, timestamp and body.');
  assert(history.messages.some(message => message.role === 'assistant' && text(message).trim()), 'A real final assistant answer must be persisted.');
}

function verifyDiscovery(history: Transcript, run: Case, payload: StoredAcceptedChatMessage, skillName: string, firstRead: number) {
  assert.equal(payload.extensionSelection, null, 'Natural discovery must start without an explicit extension selection.');
  assert(!payload.body?.bundles.length, 'Natural discovery must not smuggle an inline extension.');
  const prompt = typeof payload.message.content === 'string' ? payload.message.content : payload.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  for (const recipe of [skillName, 'SKILL.md', 'search_canvas_extensions', 'canvas_extensions', 'schemaRef', 'toolRef'])
    assert(!prompt.toLowerCase().includes(recipe.toLowerCase()), 'The original natural request must not disclose a skill name or tool recipe.');
  const discovery = pair(history, run.discoveryToolCallId!, 'canvas_extensions');
  assert(discovery.call.arguments.action === 'call' && discovery.call.arguments.operation === 'search_canvas_extensions');
  const query = record(discovery.call.arguments.arguments).query; assert(typeof query === 'string' && query.trim());
  const result = record(discovery.details.extensionDiscovery); assert(Array.isArray(result.items));
  assert(result.items.some(value => { const item = record(value);
    const pin: RecordValue | null = item.package ? record(item.package) : null;
    return item.kind === 'skill' && pin && pin.resourceRef === run.packagePin.resourceRef
      && pin.publishedRevisionRef === run.packagePin.publishedRevisionRef && pin.checksum === run.packagePin.checksum
      && pin.relativeRoot === run.expectedSkill.relativeRoot; }), 'The actual discovery result must offer this exact permitted skill source.');
  assert(discovery.resultIndex < firstRead, 'The actual successful discovery result must precede the skill read.');
  assert(!history.calls.some(call => call.name === 'integrations' && call.arguments.action === 'call'), 'Natural skill discovery must not execute a provider business operation.');
}

async function verifyIntegration(fixture: ChatExtensionNaturalModelFixture, history: Transcript, run: Case,
  payload: StoredAcceptedChatMessage, lastRead: number) {
  const selected = payload.extensionSelection; assert(selected && payload.body?.bundles.length, 'The inline case requires a genuine exact admitted bundle.');
  const plugins = selected.publicSelection.selections.filter(entry => entry.selection.kind === 'plugin');
  assert(plugins.length === 1 && plugins[0].selection.kind === 'plugin' && same(plugins[0].selection.package, run.packagePin));
  assert(selected.publicSelection.packageConnections?.some(mapping => same(mapping.package, run.packagePin)
    && mapping.connectionSelection.kind === 'mcp' && mapping.connectionSelection.target.kind === 'personal'
    && mapping.connectionSelection.target.connectionRef === run.connectionRef), 'The package declaration must explicitly map to the exact chosen MCP.');
  const bindings = selected.privateFixedBindings.filter(binding => binding.entry.selection.kind === 'mcp'
    && binding.entry.selection.target.kind === 'personal' && binding.entry.selection.target.connectionRef === run.connectionRef);
  assert.equal(bindings.length, 1); const target = bindings[0].entry.target;
  assert(target.kind === 'personal' && target.source === 'mcp' && target.ownerUserId === fixture.actorId && target.personalBinding.source === 'mcp');
  const binding = target.personalBinding;
  assert.equal(`mcp-personal:${binding.connectionId}`, run.connectionRef);
  const { createPersonalWorkflowProviderMetadataReference } = await import('../../app/lib/integration-tools/workflow-provider-presentation');
  assert.equal(createPersonalWorkflowProviderMetadataReference(binding), target.boundProviderRef);
  const { requireMcpUserAccess, assertPersonalMcpConnectionMetadataAccess } = await import('../../app/lib/mcp/access');
  const { readExistingConfig } = await import('../../app/lib/mcp/read-only-config');
  const { resolveMcpConfigPath } = await import('../../app/lib/mcp/config');
  const actor = await requireMcpUserAccess({ userId: fixture.actorId }); assert(actor);
  const config = await readExistingConfig(resolveMcpConfigPath({ userId: fixture.actorId }));
  const connections = Object.values(config.mcpServers).filter(connection => connection.connectionId === binding.connectionId);
  assert.equal(connections.length, 1); const connection = connections[0];
  await assertPersonalMcpConnectionMetadataAccess(connection, { userId: fixture.actorId }, actor);
  assert(connection.ownerUserId === fixture.actorId && connection.enabled !== false && connection.url === fixture.mcpUrl
    && (connection.serverDefinitionId ?? null) === binding.serverDefinitionId, 'The actual current private MCP config must match the admitted exact source.');
  const describe = pair(history, run.describeToolCallId!, 'integrations'), call = pair(history, run.callToolCallId!, 'integrations');
  assert(describe.call.arguments.action === 'describe' && call.call.arguments.action === 'call'
    && describe.call.arguments.toolRef === call.call.arguments.toolRef && describe.details.toolRef === call.call.arguments.toolRef
    && describe.details.schemaRef === call.call.arguments.schemaRef && describe.details.providerRef === target.boundProviderRef,
  'The call must use the exact provider, tool and schema issued by its successful describe.');
  const inputSchema = record(describe.details.inputSchema), argumentsValue = record(call.call.arguments.arguments);
  assert(record(inputSchema.properties).message && Array.isArray(inputSchema.required) && inputSchema.required.includes('message'));
  assert(Object.keys(argumentsValue).length === 1 && typeof argumentsValue.message === 'string' && argumentsValue.message.includes(fixture.nonce),
    'The actual echo call must carry the unique owned task input.');
  const toolPages = history.calls.filter(item => item.name === 'integrations' && ['list', 'search'].includes(String(item.arguments.action))
    && item.arguments.target === 'tools' && item.arguments.providerRef === target.boundProviderRef).map(item => pair(history, item.id, 'integrations'));
  assert(toolPages.some(page => page.resultIndex < describe.call.messageIndex && Array.isArray(page.details.tools)
    && page.details.tools.some(value => { const tool = record(value); return tool.name === 'echo' && tool.toolRef === call.call.arguments.toolRef
      && tool.providerRef === target.boundProviderRef; })), 'Targeted actual tool discovery must precede describe for the exact MCP.');
  const tag = record(call.details.integrations);
  assert(tag.action === 'call' && tag.source === 'mcp' && tag.providerRef === target.boundProviderRef
    && tag.toolRef === call.call.arguments.toolRef, 'The successful result must identify the exact admitted MCP route.');
  assert(lastRead < describe.call.messageIndex && describe.resultIndex < call.call.messageIndex, 'Complete skill read, describe and call must occur in that order.');
  assert.equal(text(call.result), argumentsValue.message, 'The actual MCP result must echo the exact submitted nonce-bearing message.');
  assert.equal(history.calls.filter(item => item.name === 'integrations' && item.arguments.action === 'call').length, 1);
}

/** Independent post-browser readback. Browser IDs and hashes are expectations, never source or execution authority. */
export async function verifyChatExtensionNaturalModelFixture(fixture: ChatExtensionNaturalModelFixture,
  provider: { mcpToolCalls: number; composioBusinessCalls: number }) {
  let phase = 'owned_fixture';
  try {
    await assertOwnedFixture(fixture);
    phase = 'private_browser_proof';
    const proof = chatExtensionNaturalModelProofSchema.parse(JSON.parse((await ownedBytes(path.join(fixture.root,
      'chat-extension-natural-model-proof.json'), { private: true, maxBytes: 262_144 })).toString('utf8')));
    assert.equal(proof.nonce, fixture.nonce); assert.equal(proof.actorId, fixture.actorId);
    assert.deepEqual(proof.cases.map(run => run.kind).sort(), ['inline_plugin', 'natural_discovery']);
    assert.equal(new Set(proof.cases.map(run => run.sessionId)).size, 2);
    assert.equal(provider.mcpToolCalls, 1); assert.equal(provider.composioBusinessCalls, 0);
    const { readIntegrationToolGatewayAvailability } = await import('../../app/lib/integration-tool-gateway-availability');
    assert(same(readIntegrationToolGatewayAvailability(), proof.gateway), 'The experimental gateway setting must match the actual final server file.');
    const results = [];
    for (const run of proof.cases) { phase = run.kind; results.push(await verifyCase(fixture, proof, run)); }
    phase = 'final_owned_fixture'; await assertOwnedFixture(fixture);
    return { verified: true, cases: results, externalLlm: true, controlledConnectors: true,
      actualSqlHistory: true, completeReadBytesVerified: true, literalResolvedPathObserved: false,
      mcpToolCalls: provider.mcpToolCalls, composioBusinessCalls: provider.composioBusinessCalls };
  } catch (error) {
    // Assert values may include model/source content; retain only the phase,
    // error class and numeric verifier location, never assert values or raw stacks.
    const code = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error.name) ? error.name : 'Error';
    const sourceLine = error instanceof Error ? error.stack?.match(/\n\s+at [^\n]*\/scripts\/helpers\/chat-extension-natural-model-proof\.ts:(\d+):\d+\)?/u)?.[1] : undefined;
    throw new Error(`Natural model parent verification failed during ${phase} (${code}${sourceLine ? `, verifier line ${sourceLine}` : ''}).`);
  }
}
