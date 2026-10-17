import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatBodyV1 } from '../../app/lib/chat/chat-body-contracts';
import type { ChatMessageQueueState } from '../../app/lib/pi/durable-message-admission';
import type { ChatInlineFixtureModel } from './chat-inline-model-fixture';

export type ChatQueueRecoveryBrowserFixtureInput = {
  root: string; nonce: string; actorId: string; dataRoot: string; databaseName: string; baseURL: string;
  model: Pick<ChatInlineFixtureModel, 'providerInstallationId' | 'providerId' | 'modelId' | 'thinkingLevel' | 'expectedCatalogRevision'>;
};
export type ChatQueueRecoveryBrowserEntry = {
  sessionId: string; clientMessageId: string; serverMessageId: string; executionRevision: number;
  text: string; queue: ChatMessageQueueState | null;
};
export type ChatQueueRecoveryBrowserSession = ChatQueueRecoveryBrowserEntry & {
  cancelTarget?: ChatQueueRecoveryBrowserEntry;
  blockerClientMessageId?: string;
  blockerReason?: 'legacy' | 'outcome_unknown' | 'execution_in_progress';
};
export type ChatQueueRecoveryBrowserFixture = {
  workspaceId: string; agentId: string; agentName: string;
  sessions: Record<'ready' | 'suspended' | 'unpositioned' | 'legacy' | 'unknown' | 'inflight', ChatQueueRecoveryBrowserSession>;
};
type PrivateRow = { session_id: string; client_message_id: string; private_payload: string | null; payload_hash: string;
  execution_phase: string | null; execution_revision: number | string | null; runtime_token: string;
  queue_lane: string | null; queue_ordinal: number | string | null; queue_disposition: string | null };
const seedFile = 'chat-queue-recovery-seed.json';
const proofFile = 'chat-queue-recovery-ui-proof.json';
const hash = (value: string | null) => createHash('sha256').update(value ?? 'null').digest('hex');
type SeedStage = 'arguments' | 'read_fixture' | 'sdk_import' | 'owned_scope' | 'workspace' | 'agent' | 'session'
  | 'admission' | 'suspended' | 'unpositioned' | 'legacy' | 'unknown' | 'inflight' | 'invalidate' | 'seed_proof' | 'write_prepared';
let seedStage: SeedStage = 'arguments';

function reportSeedFailure(error: unknown): void {
  const candidate = error instanceof Error ? error : null;
  const name = candidate && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(candidate.name) ? candidate.name : 'UnknownError';
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  const frames = candidate && typeof candidate.stack === 'string'
    ? candidate.stack.split('\n').filter(line => /^\s+at /u.test(line)).slice(0, 8).map(line => line.slice(0, 1024)) : [];
  console.log('CHAT_QUEUE_RECOVERY_SEED_FAILED', JSON.stringify({ stage: seedStage, name,
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? { code } : {}), frames }));
}

async function privateJson(file: string) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.()
    && (stat.mode & 0o777) === 0o600 && stat.size <= 1_048_576);
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
}

/** No mutation until the exact runner directory, marker, database and actual owner are verified. */
async function assertOwnedFixture(fixture: ChatQueueRecoveryBrowserFixtureInput): Promise<void> {
  assert.match(fixture.nonce, /^[a-f0-9]{32}$/u);
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_CHAT_INLINE_E2E, '1');
  assert.equal(process.env.CANVAS_PLUGIN_EXTENSION_E2E, '1');
  assert(path.isAbsolute(fixture.root) && fixture.root === await fs.realpath(fixture.root));
  const stat = await fs.lstat(fixture.root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
  assert.equal(fixture.dataRoot, path.join(fixture.root, 'data')); assert.equal(await fs.realpath(fixture.dataRoot), fixture.dataRoot);
  assert.equal(process.env.DATA, fixture.dataRoot); assert.equal(process.env.CANVAS_DATA_ROOT, fixture.dataRoot);
  assert.equal(process.env.PLUGIN_EXTENSION_E2E_ROOT, fixture.root); assert.equal(process.env.PLUGIN_EXTENSION_E2E_NONCE, fixture.nonce);
  assert.equal(fixture.databaseName, `canvas_plugin_extension_test_${fixture.nonce}`);
  assert.equal(fixture.baseURL, 'http://127.0.0.1:3001'); assert.equal(process.env.BASE_URL, fixture.baseURL);
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port === '55433' && !url.search && !url.hash);
  assert.equal(url.pathname, `/${fixture.databaseName}`);
  const markerPath = path.join(fixture.root, '.fixture-owner'), markerStat = await fs.lstat(markerPath);
  assert(markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1 && markerStat.uid === process.getuid?.()
    && (markerStat.mode & 0o777) === 0o600 && markerStat.size === 48);
  const marker = await fs.readFile(markerPath, 'utf8'); assert.match(marker, /^[a-f0-9]{48}$/u);
  const receipt = await privateJson(path.join(fixture.root, 'recovery.json'));
  assert.equal(receipt.version, 1); assert.equal(receipt.nonce, fixture.nonce); assert.equal(receipt.actorId, fixture.actorId);
  assert.equal(receipt.fixtureRoot, fixture.root); assert.equal(receipt.dataRoot, fixture.dataRoot);
  assert.equal(receipt.databaseName, fixture.databaseName); assert.equal(receipt.ownerMarker, marker);
  assert.equal(receipt.createAcknowledged, true); assert.equal(receipt.databaseDropped, false); assert.equal(receipt.uncertain, false);
  assert.equal(receipt.rootDevice, String(stat.dev)); assert.equal(receipt.rootInode, String(stat.ino));
  const { openDb } = await import('../../app/lib/db'); const database = await openDb();
  try {
    const actual = await database.get('SELECT current_database() AS name,current_user AS role') as { name: string; role: string };
    assert.equal(actual.name, fixture.databaseName);
    const owner = await database.get("SELECT pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
      [fixture.databaseName]) as { owner: string; marker: string };
    assert.equal(owner.owner, actual.role); assert.equal(owner.marker, marker);
    const actor = await database.get('SELECT id,role FROM "user" WHERE id=$1', [fixture.actorId]) as { id: string; role: string } | undefined;
    assert.equal(actor?.id, fixture.actorId); assert.equal(actor?.role, 'admin');
  } finally { await database.close(); }
}

async function rows(input: ChatQueueRecoveryBrowserFixtureInput, prepared: ChatQueueRecoveryBrowserFixture): Promise<PrivateRow[]> {
  const { openDb } = await import('../../app/lib/db'); const database = await openDb();
  try {
    return await database.all(`SELECT s.session_id,r.client_message_id,r.private_payload,r.payload_hash,r.execution_phase,
      r.execution_revision,r.runtime_token,r.queue_lane,r.queue_ordinal,r.queue_disposition
      FROM pi_message_delivery_receipts r JOIN pi_sessions s ON s.id=r.pi_session_db_id
      WHERE s.user_id=$1 AND s.agent_id=$2 AND s.workspace_id=$3 ORDER BY s.session_id,r.client_message_id`,
    [input.actorId, prepared.agentId, prepared.workspaceId]) as PrivateRow[];
  } finally { await database.close(); }
}

/** Seeds actual durable SQL through public writers; no prompt, model request or manufactured runtime owner. */
export async function prepareChatQueueRecoveryBrowserFixture(input: ChatQueueRecoveryBrowserFixtureInput): Promise<ChatQueueRecoveryBrowserFixture> {
  seedStage = 'owned_scope';
  await assertOwnedFixture(input);
  seedStage = 'workspace';
  const { resolveAgentSessionWorkspaceForUser, workspaceToPiSessionFields, workspaceToChatRequestWorkspace } = await import('../../app/lib/pi/session-workspace-context');
  const workspace = await resolveAgentSessionWorkspaceForUser({ userId: input.actorId, permissions: ['canRead', 'canRunAgent'] });
  assert.equal(workspace.workspaceType, 'personal');
  assert.equal(workspace.organizationId, process.env.CANVAS_ORGANIZATION_ID);
  const { createManagedAgent } = await import('../../app/lib/agents/management-actions');
  const agentName = `Queue recovery ${input.nonce.slice(0, 10)}`;
  seedStage = 'agent';
  const created = await createManagedAgent({ userId: input.actorId, workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId, source: 'api' }, { name: agentName, scopeType: 'user', enabledTools: ['read'],
    defaultProviderInstallationId: input.model.providerInstallationId, defaultProvider: input.model.providerId,
    defaultModel: input.model.modelId, defaultThinking: input.model.thinkingLevel, expectedCatalogRevision: input.model.expectedCatalogRevision,
    extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] } });
  const agentId = created.agent.agentId, sessionIds: string[] = [];
  const admission = await import('../../app/lib/pi/durable-message-admission');
  const execution = await import('../../app/lib/pi/durable-message-execution');
  const runtimeApi = await import('../../app/lib/pi/live-runtime');
  const { openDb } = await import('../../app/lib/db');
  const { resolveExecutableAgentRuntime } = await import('../../app/lib/agent-runtime-policy/provider-runtime');
  const { sessionRuntimeSnapshotFromResolvedSelection } = await import('../../app/lib/agent-runtime-policy/runtime-snapshot');
  const { createPiSessionWithRuntimeSnapshot } = await import('../../app/lib/pi/session-store');
  const { createPiSystemPromptSnapshot } = await import('../../app/lib/pi/system-prompt-snapshot');
  const session = async (kind: string) => {
    seedStage = 'session';
    const sessionId = `queue-${kind}-${input.nonce}`;
    const resolved = await resolveExecutableAgentRuntime({ organizationId: workspace.organizationId!, userId: input.actorId,
      workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType, agentId,
      requestedSelection: { providerInstallationId: input.model.providerInstallationId, providerId: input.model.providerId,
        modelId: input.model.modelId, thinkingLevel: input.model.thinkingLevel },
      executionMode: 'interactive', principal: { type: 'user', userId: input.actorId, credentialSubjectUserId: input.actorId } });
    await createPiSessionWithRuntimeSnapshot({ userId: input.actorId, sessionId, agentId, title: `Queue recovery ${kind}`,
      workspace: workspaceToPiSessionFields(workspace), runtimeSnapshot: sessionRuntimeSnapshotFromResolvedSelection(resolved.selection),
      systemPromptSnapshot: await createPiSystemPromptSnapshot(agentId, { userId: input.actorId,
        organizationId: workspace.organizationId, workspaceId: workspace.workspaceId }) });
    sessionIds.push(sessionId); return sessionId;
  };
  const fresh = async (sessionId: string, clientMessageId: string) => {
    const owned = await admission.readOwnedAcceptedChatMessage({ userId: input.actorId, sessionId, clientMessageId,
      expectedAgentId: agentId, expectedWorkspaceId: workspace.workspaceId }); assert(owned); return owned;
  };
  const admit = async (sessionId: string, label: string) => {
    seedStage = 'admission';
    const clientMessageId = `queue-${label}-${input.nonce}`, text = `Saved queue ${label} ${input.nonce.slice(0, 8)}`;
    const body: ChatBodyV1 = { version: 1, parts: [{ type: 'text', text }], bundles: [] };
    // Match the real HTTP/WS JSON boundary: server projection has optional
    // undefined data fields which cannot exist in an incoming JSON message.
    const context = JSON.parse(JSON.stringify({ workspace: workspaceToChatRequestWorkspace(workspace) }));
    const prepared = await admission.prepareChatMessageAdmission({ userId: input.actorId, sessionId, clientMessageId,
      message: { role: 'user', content: text, timestamp: Date.now() }, context,
      mode: 'message', body });
    assert.equal(prepared.kind, 'prepared'); if (prepared.kind !== 'prepared') throw new Error('New queue admission required.');
    return admission.commitPreparedChatMessageAdmission(prepared.admission, { lane: 'follow_up' });
  };
  const entry = async (owned: Awaited<ReturnType<typeof fresh>>): Promise<ChatQueueRecoveryBrowserEntry> => {
    const snapshot = admission.readOwnedChatMessageExecutionSnapshot(owned);
    return { sessionId: snapshot.payload.identity.sessionId, clientMessageId: snapshot.payload.clientMessageId,
      serverMessageId: snapshot.payload.serverMessageId, executionRevision: snapshot.executionRevision,
      text: typeof snapshot.payload.message.content === 'string' ? snapshot.payload.message.content : '',
      queue: snapshot.queue };
  };
  try {
    const ready = await entry(await admit(await session('ready'), 'ready'));
    const suspendedSession = await session('suspended'), paused = await admit(suspendedSession, 'suspended');
    const promoted = await admit(suspendedSession, 'promoted-only-to-pause');
    seedStage = 'suspended';
    await execution.promoteOwnedQueuedChatMessage(promoted);
    await execution.cancelOwnedQueuedChatMessages([await fresh(suspendedSession, admission.readOwnedChatMessageExecutionSnapshot(promoted).payload.clientMessageId)]);
    const suspended = await entry(await fresh(suspendedSession, admission.readOwnedChatMessageExecutionSnapshot(paused).payload.clientMessageId));
    assert.equal(suspended.queue?.disposition, 'suspended');
    const nullSession = await session('unpositioned'), unpositionedOwned = await admit(nullSession, 'unpositioned-resume');
    const cancelOwned = await admit(nullSession, 'unpositioned-cancel');
    seedStage = 'unpositioned';
    // Explicit pre-migration storage fixture: a valid V1 payload predates queue columns.
    const database = await openDb();
    try { await database.run(`UPDATE pi_message_delivery_receipts SET queue_lane=NULL,queue_ordinal=NULL,queue_disposition=NULL
      WHERE pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2 AND agent_id=$3 AND workspace_id=$4)`,
    [input.actorId, nullSession, agentId, workspace.workspaceId]); } finally { await database.close(); }
    const unpositioned: ChatQueueRecoveryBrowserSession = await entry(await fresh(nullSession, admission.readOwnedChatMessageExecutionSnapshot(unpositionedOwned).payload.clientMessageId));
    unpositioned.cancelTarget = await entry(await fresh(nullSession, admission.readOwnedChatMessageExecutionSnapshot(cancelOwned).payload.clientMessageId));
    assert.equal(unpositioned.queue, null); assert.equal(unpositioned.cancelTarget.queue, null);
    const legacySession = await session('legacy'), legacy: ChatQueueRecoveryBrowserSession = await entry(await admit(legacySession, 'legacy-follower'));
    seedStage = 'legacy';
    legacy.blockerClientMessageId = `queue-legacy-blocker-${input.nonce}`; legacy.blockerReason = 'legacy';
    const oldDatabase = await openDb();
    try { await oldDatabase.run(`INSERT INTO pi_message_delivery_receipts
      (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,created_at,updated_at)
      VALUES((SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2 AND agent_id=$3 AND workspace_id=$4),$5,$6,$7,'accepted',$8,$8)`,
    [input.actorId, legacySession, agentId, workspace.workspaceId, legacy.blockerClientMessageId,
      hash(`historical-legacy-${input.nonce}`), 'historical-legacy-no-runtime-proof', Date.now()]); } finally { await oldDatabase.close(); }
    const block = async (kind: 'unknown' | 'inflight'): Promise<ChatQueueRecoveryBrowserSession> => {
      const sessionId = await session(kind), owned = await admit(sessionId, `${kind}-blocker`);
      seedStage = kind;
      const { runtime } = await runtimeApi.getOrCreatePiRuntimeWithState(sessionId, input.actorId, { metadataOnlyExternal: true });
      const owner = await runtimeApi.getRegisteredPiRuntimeExecutionOwner(runtime);
      const claim = await execution.claimOwnedChatMessageExecution(owned, owner);
      if (kind === 'unknown') {
        const running = await execution.startClaimedChatMessageExecution(claim);
        await execution.finishClaimedChatMessageExecution(running.claim, 'outcome_unknown');
      }
      const follower = await entry(await admit(sessionId, `${kind}-follower`));
      return { ...follower, blockerClientMessageId: admission.readOwnedChatMessageExecutionSnapshot(owned).payload.clientMessageId,
        blockerReason: kind === 'unknown' ? 'outcome_unknown' : 'execution_in_progress' };
    };
    const unknown = await block('unknown'), inflight = await block('inflight');
    const result: ChatQueueRecoveryBrowserFixture = { workspaceId: workspace.workspaceId, agentId, agentName,
      sessions: { ready, suspended, unpositioned, legacy, unknown, inflight } };
    seedStage = 'invalidate';
    for (const sessionId of sessionIds) {
      await runtimeApi.invalidatePiRuntime(sessionId, input.actorId);
      assert.equal(await runtimeApi.getExistingPiRuntime(sessionId, input.actorId), null);
    }
    const originals = await rows(input, result);
    seedStage = 'seed_proof';
    assert.equal(originals.length, 11);
    const observed = await openDb();
    try {
      const history = await observed.get(`SELECT count(*) AS count FROM pi_messages WHERE pi_session_db_id IN
        (SELECT id FROM pi_sessions WHERE user_id=$1 AND agent_id=$2)`, [input.actorId, agentId]) as { count: string | number };
      assert.equal(Number(history.count), 0, 'Seeding never executes a prompt or writes a transcript.');
    } finally { await observed.close(); }
    await fs.writeFile(path.join(input.root, seedFile), JSON.stringify({ version: 1, nonce: input.nonce, actorId: input.actorId,
      prepared: result, rows: originals.map(row => ({ ...row, private_payload: hash(row.private_payload) })) }), { mode: 0o600, flag: 'wx' });
    return result;
  } finally {
    for (const sessionId of sessionIds) await runtimeApi.invalidatePiRuntime(sessionId, input.actorId);
  }
}

/** Parent-side SQL audit after actual browser actions; no browser DTO grants authority. */
export async function verifyChatQueueRecoveryBrowserFixture(input: ChatQueueRecoveryBrowserFixtureInput, prepared: ChatQueueRecoveryBrowserFixture) {
  await assertOwnedFixture(input);
  const seed = await privateJson(path.join(input.root, seedFile)), proof = await privateJson(path.join(input.root, proofFile));
  assert.equal(seed.version, 1); assert.equal(seed.nonce, input.nonce); assert.equal(seed.actorId, input.actorId);
  assert.deepEqual(seed.prepared, prepared); assert.equal(proof.version, 1); assert.equal(proof.nonce, input.nonce);
  assert.equal(proof.actorId, input.actorId); assert.equal(proof.agentId, prepared.agentId);
  assert.equal(proof.completedCases, 4); assert.equal(proof.forbiddenUiCalls, 0); assert.equal(proof.runtimeErrors, 0);
  assert.equal(proof.newSendFrames, 0);
  const actual = await rows(input, prepared), originals = seed.rows as Array<PrivateRow>;
  assert.equal(actual.length, originals.length, 'Recovery never creates another admitted message.');
  for (const before of originals) {
    const after = actual.find(row => row.session_id === before.session_id && row.client_message_id === before.client_message_id); assert(after);
    assert.equal(hash(after.private_payload), before.private_payload); assert.equal(after.payload_hash, before.payload_hash);
  }
  const find = (item: ChatQueueRecoveryBrowserEntry) => {
    const row = actual.find(value => value.session_id === item.sessionId && value.client_message_id === item.clientMessageId); assert(row); return row;
  };
  for (const item of [prepared.sessions.ready, prepared.sessions.suspended, prepared.sessions.unpositioned]) {
    const row = find(item); assert.equal(row.execution_phase, 'succeeded');
    assert.equal(Number(row.execution_revision), item.executionRevision + (item.queue?.disposition === 'ready' ? 3 : 4));
  }
  const cancel = prepared.sessions.unpositioned.cancelTarget; assert(cancel);
  assert.equal(find(cancel).execution_phase, 'cancelled'); assert.equal(Number(find(cancel).execution_revision), cancel.executionRevision + 1);
  for (const kind of ['legacy', 'unknown', 'inflight'] as const) {
    const session = prepared.sessions[kind];
    const before = originals.find(row => row.session_id === session.sessionId && row.client_message_id === session.blockerClientMessageId); assert(before);
    const after = actual.find(row => row.session_id === session.sessionId && row.client_message_id === session.blockerClientMessageId); assert(after);
    assert.deepEqual({ ...after, private_payload: hash(after.private_payload) }, before, 'Uncertain and historical executions are never stolen or reclassified.');
    assert.equal(find(session).execution_phase, 'queued'); assert.equal(Number(find(session).execution_revision), session.executionRevision);
  }
  const { openDb } = await import('../../app/lib/db'); const database = await openDb();
  try {
    const transcript = await database.all(`SELECT s.session_id,m.content FROM pi_messages m JOIN pi_sessions s ON s.id=m.pi_session_db_id
      WHERE s.user_id=$1 AND s.agent_id=$2 AND m.role='user' ORDER BY s.session_id,m.id`, [input.actorId, prepared.agentId]) as { session_id: string; content: string }[];
    assert.equal(transcript.length, 3);
    for (const target of [prepared.sessions.ready, prepared.sessions.suspended, prepared.sessions.unpositioned]) {
      const messages = transcript.filter(row => row.session_id === target.sessionId); assert.equal(messages.length, 1);
      const stored = JSON.parse(messages[0].content) as { body?: ChatBodyV1; clientMessageId?: string; serverMessageId?: string };
      assert.equal(stored.clientMessageId, target.clientMessageId); assert.equal(stored.serverMessageId, target.serverMessageId);
      assert.deepEqual(stored.body, { version: 1, parts: [{ type: 'text', text: target.text }], bundles: [] });
    }
  } finally { await database.close(); }
  return { verified: true, executedMessages: 3, preservedBlockers: 3, originalPayloadsUnchanged: true };
}

/** The canonical runner awaits this child's exit before starting the production host. */
async function seedChild(): Promise<void> {
  assert.equal(process.argv.length, 4); assert.equal(process.argv[2], '--seed');
  const file = process.argv[3]; assert(path.isAbsolute(file) && file === await fs.realpath(file));
  seedStage = 'read_fixture';
  const fixture = await privateJson(file) as unknown as ChatQueueRecoveryBrowserFixtureInput;
  assert.equal(path.dirname(file), fixture.root); assert.equal(path.basename(file), 'fixture.json');
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load, sdk = new Map<string, unknown>();
  try {
    seedStage = 'sdk_import';
    // Bridge only actual import-only Pi namespaces, as the existing native worker does.
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) {
      sdk.set(name, await import(name));
    }
    loader._load = (name, parent, isMain) => sdk.has(name) ? sdk.get(name) : originalLoad(name, parent, isMain);
    const prepared = await prepareChatQueueRecoveryBrowserFixture(fixture);
    seedStage = 'write_prepared';
    await fs.writeFile(path.join(fixture.root, 'chat-queue-recovery-prepared.json'), JSON.stringify({ version: 1,
      nonce: fixture.nonce, prepared }), { mode: 0o600, flag: 'wx' });
  } finally {
    try { const { closeDatabaseConnections } = await import('../../app/lib/db'); await closeDatabaseConnections(); }
    finally { loader._load = originalLoad; }
  }
}

// tsx uses CommonJS in this repository; the ESM branch retains the actual file URL.
const ownPath = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ownPath)) {
  void seedChild().catch(error => { reportSeedFailure(error); process.exitCode = 1; });
}
