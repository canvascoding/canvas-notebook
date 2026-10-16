import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { extensionPackagePinSchema, standaloneExtensionSelectionSchema } from '../../app/lib/capabilities/extensions/contracts';
import { assertChatBodyContent, assertChatBodySelection, parseChatBody, projectChatBodyText } from '../../app/lib/chat/chat-body-contracts';
import { assertNativeCentralAgentUnchanged, nativeCentralAgentSnapshotSchema, projectNativeCentralAgentSnapshot } from './chat-extension-native-agent-snapshot';
import { assertNativeRetypedSkillCaption, nativeExtensionSkillCaption } from './chat-extension-native-fixture';
import { assertNativeSdkTurnProofs, nativeSqlUserTextFingerprint, type NativeExpectedSdkTurn } from './chat-extension-native-sdk-proof';

type Fixture = { root: string; nonce: string; actorId: string; dataRoot: string; databaseName: string; baseURL: string; mcpUrl: string; model: { providerInstallationId: string; providerId: string; modelId: string } };
type RecordValue = Record<string, unknown>;
const identifier = z.string().min(1).max(256), sha = z.string().regex(/^[a-f0-9]{64}$/u);
const runSchema = z.object({ platform: z.enum(['ios', 'android']), sessionId: identifier, agentId: identifier, workspaceId: identifier,
  marker: identifier, createdAgentId: identifier, selectedAccount: standaloneExtensionSelectionSchema,
  pluginPin: extensionPackagePinSchema, skillPin: extensionPackagePinSchema, skillCaption: identifier, mcpRef: identifier, standaloneMcpRef: identifier, packageMcpToolCap: z.array(identifier).nullable(), capabilityKey: identifier,
  centralAgentSnapshots: z.object({ before: nativeCentralAgentSnapshotSchema, after: nativeCentralAgentSnapshotSchema }).strict() }).strict();
const receiptSchema = z.object({ version: z.literal(1), status: z.literal('passed'), nonce: identifier, platform: z.enum(['ios', 'android']),
  phase: z.enum(['chat', 'agent-create', 'agent-edit', 'agent-package-policy', 'my-connection']), device: identifier, deviceOwnershipPath: z.string(),
  initialAppStateReset: z.boolean(), initialIosDeviceKeychainReset: z.boolean(), deviceName: identifier,
  nativeBuild: z.string().regex(/^[1-9][0-9]*$/u), nativeSourceSha256: sha, nativeVersion: identifier, applicationId: z.literal('app.canvasnotebook.mobile.dev'),
  maestroDevice: identifier, maestroHost: z.literal('127.0.0.1').nullable(), maestroPort: z.number().int().min(1024).max(65535).nullable(),
  metroPid: z.number().int().positive(), metroPort: z.number().int().min(1024).max(65535),
  featureFiles: z.record(z.string(), sha), featureSourceSha256: sha, featureSourceSha256After: sha,
  actualMaestro: z.literal(true), physicalDeviceChecked: z.literal(false), junitPath: z.string(), hierarchyPath: z.string(), screenshotPath: z.string(),
  exitCode: z.literal(0), timedOut: z.literal(false) }).passthrough();
const proofSchema = z.object({ version: z.literal(1), nonce: identifier, actorId: identifier, platforms: z.array(runSchema).length(2),
  receipts: z.array(receiptSchema).length(10), controlledSdkTransport: z.literal(true), externalLlm: z.literal(false), actualNativeCompletion: z.literal(true) }).strict();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown) => { assert.deepEqual(left, right); };
function record(value: unknown): RecordValue { assert(value && typeof value === 'object' && !Array.isArray(value)); return value as RecordValue; }
async function bytes(filename: string, privateMode = true, maximum = 4 * 1024 * 1024) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(); assert(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.() && before.size > 0 && before.size <= maximum
      && (!privateMode || (before.mode & 0o777) === 0o600));
    const content = await handle.readFile();
    for (const after of [await handle.stat(), await fs.lstat(filename)]) assert(after.isFile() && !after.isSymbolicLink() && after.nlink === before.nlink && after.dev === before.dev
      && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && after.mode === before.mode && after.uid === before.uid);
    return content;
  } finally { await handle.close(); }
}
async function ownedFixture(fixture: Fixture) {
  assert.equal(process.env.CANVAS_CHAT_NATIVE_E2E, '1'); assert.equal(process.env.CANVAS_PLUGIN_EXTENSION_E2E, '1'); assert.equal(process.env.NODE_ENV, 'test');
  assert.match(fixture.nonce, /^[a-f0-9]{32}$/u); assert.equal(fixture.databaseName, `canvas_plugin_extension_test_${fixture.nonce}`);
  assert.equal(await fs.realpath(fixture.root), fixture.root); assert.equal(fixture.dataRoot, path.join(fixture.root, 'data'));
  const stat = await fs.lstat(fixture.root); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
  assert.equal(process.env.DATA, fixture.dataRoot); assert.equal(process.env.CANVAS_DATA_ROOT, fixture.dataRoot);
  assert.equal(process.env.PLUGIN_EXTENSION_E2E_ROOT, fixture.root); assert.equal(process.env.PLUGIN_EXTENSION_E2E_NONCE, fixture.nonce);
  assert.equal(fixture.baseURL, 'http://127.0.0.1:3001');
  const url = new URL(process.env.DATABASE_URL!); assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433');
  assert.equal(url.pathname, `/${fixture.databaseName}`); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const marker = (await bytes(path.join(fixture.root, '.fixture-owner'), true, 48)).toString('utf8'); assert.match(marker, /^[a-f0-9]{48}$/u);
  const receipt = record(JSON.parse((await bytes(path.join(fixture.root, 'recovery.json'), true, 65_536)).toString('utf8')));
  for (const [key, expected] of Object.entries({ nonce: fixture.nonce, actorId: fixture.actorId, fixtureRoot: fixture.root, dataRoot: fixture.dataRoot,
    databaseName: fixture.databaseName, ownerMarker: marker, rootDevice: String(stat.dev), rootInode: String(stat.ino), createAcknowledged: true, databaseDropped: false, uncertain: false, listenerVerified: true })) assert.equal(receipt[key], expected);
  const { openDb } = await import('../../app/lib/db'); const database = await openDb();
  try {
    const current = record(await database.get('SELECT current_database() AS name,current_user AS role')); assert.equal(current.name, fixture.databaseName);
    const owner = record(await database.get("SELECT pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [fixture.databaseName]));
    assert.equal(owner.owner, current.role); assert.equal(owner.marker, marker);
    const actor = record(await database.get('SELECT id,role FROM "user" WHERE id=$1', [fixture.actorId])); assert.equal(actor.id, fixture.actorId); assert.equal(actor.role, 'admin');
  } finally { await database.close(); }
}
/** Before Native launch, independently check the Session201 result against its owned SQL row. */
export async function assertNativePreparedSessionIdentity(fixture: Fixture, expected: { sessionId: string; agentId: string; workspaceId: string }) {
  await ownedFixture(fixture);
  const { openDb } = await import('../../app/lib/db'); const database = await openDb();
  try {
    const row = record(await database.get(`SELECT s.session_id,s.agent_id,s.user_id,s.workspace_id,w.owner_user_id,w.status
      FROM pi_sessions s JOIN canvas_workspaces w ON w.id=s.workspace_id WHERE s.session_id=$1 AND s.user_id=$2`, [expected.sessionId, fixture.actorId]));
    assert.equal(row.session_id, expected.sessionId); assert.equal(row.agent_id, expected.agentId); assert.equal(row.workspace_id, expected.workspaceId);
    assert.equal(row.user_id, fixture.actorId); assert.equal(row.owner_user_id, fixture.actorId); assert.equal(row.status, 'active');
  } finally { await database.close(); }
}
async function artifact(fixture: Fixture, filename: string, expected: string, maximum: number) {
  assert.equal(filename, path.join(fixture.root, expected)); assert.equal(await fs.realpath(path.dirname(filename)), path.dirname(filename));
  const stat = await fs.lstat(path.dirname(filename)); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
  return bytes(filename, true, maximum);
}
async function verifyNativeArtifacts(fixture: Fixture, proof: z.infer<typeof proofSchema>) {
  const config = record(JSON.parse((await bytes(process.env.CANVAS_NATIVE_EXTENSION_DEVICE_CONFIG!)).toString('utf8')));
  assert.equal(config.version, 1); assert.equal(config.applicationId, 'app.canvasnotebook.mobile.dev'); const metro = record(config.metro);
  assert(typeof config.deviceOwnershipPath === 'string' && path.isAbsolute(config.deviceOwnershipPath) && path.basename(config.deviceOwnershipPath) === 'owned-devices.json');
  const deviceRoot = await fs.realpath(path.dirname(config.deviceOwnershipPath)), deviceRootStat = await fs.lstat(deviceRoot);
  assert(/^canvas-chat-native-devices-[A-Za-z0-9]+$/u.test(path.basename(deviceRoot)) && deviceRootStat.isDirectory() && !deviceRootStat.isSymbolicLink()
    && deviceRootStat.uid === process.getuid?.() && (deviceRootStat.mode & 0o777) === 0o700);
  const devices = record(JSON.parse((await bytes(config.deviceOwnershipPath)).toString('utf8'))); assert.equal(devices.version, 1);
  assert(typeof devices.root === 'string'); assert.equal(await fs.realpath(devices.root), deviceRoot);
  for (const [platform, fields] of [['ios', ['udid', 'name']], ['android', ['serial', 'avdName', 'adbServerPort']]] as const)
    for (const field of fields) assert.equal(record(config[platform])[field], record(devices[platform])[field]);
  assert.equal(new Set(proof.receipts.map(row => `${row.platform}:${row.phase}`)).size, 10);
  assert.equal(new Set(proof.receipts.map(row => row.featureSourceSha256)).size, 1, 'Every platform and phase must use identical frozen feature sources.');
  for (const receipt of proof.receipts) {
    assert.equal(receipt.deviceOwnershipPath, config.deviceOwnershipPath); assert.equal(receipt.initialAppStateReset, receipt.phase === 'chat');
    assert.equal(receipt.initialIosDeviceKeychainReset, receipt.platform === 'ios' && receipt.phase === 'chat');
    const device = record(config[receipt.platform]); assert.equal(receipt.device, device.udid ?? device.serial); assert.equal(receipt.deviceName, device.name ?? device.avdName);
    if (receipt.platform === 'ios') { assert.equal(receipt.maestroDevice, receipt.device); assert.equal(receipt.maestroHost, null); assert.equal(receipt.maestroPort, null); }
    else {
      assert.match(receipt.device, /^emulator-[0-9]{4,5}$/u); const adbdPort = Number(receipt.device.slice('emulator-'.length)) + 1;
      assert.equal(receipt.maestroHost, '127.0.0.1'); assert.equal(receipt.maestroPort, adbdPort); assert.equal(receipt.maestroDevice, `127.0.0.1:${adbdPort}`);
      assert.notEqual(receipt.maestroPort, device.adbServerPort);
    }
    assert.equal(receipt.nativeBuild, String(device.expectedBuild)); assert.equal(receipt.nativeVersion, device.expectedVersion);
    assert.equal(receipt.metroPid, metro.pid); assert.equal(receipt.metroPort, metro.port);
    assert.equal(receipt.nativeSourceSha256, device.nativeSourceSha256);
    assert.equal(receipt.nativeSourceSha256, hash(JSON.stringify(Object.fromEntries(Object.entries(receipt.featureFiles).filter(([file]) => file.startsWith('modules/canvas-chat-keyboard/'))))));
    assert.equal(receipt.nonce, fixture.nonce); assert.equal(receipt.featureSourceSha256After, receipt.featureSourceSha256);
    assert.equal(hash(JSON.stringify(receipt.featureFiles)), receipt.featureSourceSha256); assert(Object.keys(receipt.featureFiles).length > 30);
    const receiptPath = path.join(fixture.root, `native-${receipt.platform}-${receipt.phase}.json.receipt.json`);
    same(JSON.parse((await bytes(receiptPath)).toString('utf8')), receipt);
    const base = `native-${receipt.platform}-${receipt.phase}-artifacts`;
    const xml = (await artifact(fixture, receipt.junitPath, `${base}/report.xml`, 1024 * 1024)).toString('utf8');
    assert(/<testsuite\b/u.test(xml) && /tests="[1-9][0-9]*"/u.test(xml)); assert(!/failures="[1-9]|errors="[1-9]|<failure\b|<error\b/u.test(xml));
    assert(JSON.parse((await artifact(fixture, receipt.hierarchyPath, `${base}/native-hierarchy.json`, 12 * 1024 * 1024)).toString('utf8')));
    const png = await artifact(fixture, receipt.screenshotPath, `${base}/native-final.png`, 16 * 1024 * 1024); same(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  for (const platform of ['ios', 'android']) {
    const receipts = proof.receipts.filter(row => row.platform === platform);
    for (const field of ['device', 'deviceName', 'nativeBuild', 'nativeVersion', 'metroPid', 'metroPort'] as const) assert.equal(new Set(receipts.map(row => row[field])).size, 1);
  }
  assert.notEqual(proof.receipts.find(row => row.platform === 'ios')!.device, proof.receipts.find(row => row.platform === 'android')!.device);
}
async function verifyRun(fixture: Fixture, run: z.infer<typeof runSchema>, expectedSdkTurns: NativeExpectedSdkTurn[]) {
  const { canonicalAcceptedMessageIntentHash } = await import('../../app/lib/chat/durable-message-contracts');
  const { listChatExtensionOptions } = await import('../../app/lib/chat/extension-options');
  const skillVersion = await listChatExtensionOptions({ userId: fixture.actorId, workspaceId: run.workspaceId, source: 'api' },
    { operation: 'package_version', target: { kind: 'turn', sessionId: run.sessionId, expectedAgentId: run.agentId, expectedWorkspaceId: run.workspaceId }, ...run.skillPin });
  assert(skillVersion.operation === 'package_version');
  assert.equal(run.marker, `NATIVE-${fixture.nonce}-${run.platform}`);
  assert(run.selectedAccount.kind === 'composio' && run.selectedAccount.toolkit === 'canva' && run.selectedAccount.target.kind === 'personal' && run.selectedAccount.target.accountBinding === 'account');
  const { openDb } = await import('../../app/lib/db');
  const { readOwnedAcceptedChatMessage, readOwnedChatMessageExecutionSnapshot } = await import('../../app/lib/pi/durable-message-admission');
  const database = await openDb();
  let cids: string[], sessionDbId: string | number, history: RecordValue[];
  try {
    const session = record(await database.get(`SELECT s.*,w.owner_user_id,w.status AS workspace_status FROM pi_sessions s JOIN canvas_workspaces w ON w.id=s.workspace_id
      WHERE s.user_id=$1 AND s.session_id=$2 AND s.agent_id=$3 AND s.workspace_id=$4`, [fixture.actorId, run.sessionId, run.agentId, run.workspaceId]));
    assert(session.archived_at === null && session.workspace_type === 'personal' && session.owner_user_id === fixture.actorId && session.workspace_status === 'active');
    assert.equal(session.provider, fixture.model.providerId); assert.equal(session.model, fixture.model.modelId);
    assert.equal(session.runtime_provider_installation_id, fixture.model.providerInstallationId);
    sessionDbId = session.id as string | number;
    const receipts = await database.all('SELECT client_message_id FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1', [sessionDbId]) as Array<{ client_message_id: string }>;
    cids = receipts.map(row => row.client_message_id); assert.equal(cids.length, 2); assert.equal(new Set(cids).size, 2);
    const rows = await database.all('SELECT content FROM pi_messages WHERE pi_session_db_id=$1 ORDER BY sequence,id LIMIT 129', [sessionDbId]) as Array<{ content: string }>;
    assert(rows.length < 129); history = rows.map(row => record(JSON.parse(row.content))); assert.equal(history.filter(row => row.role === 'user').length, 2);
    assert(history.some(row => row.role === 'assistant' && JSON.stringify(row.content).includes('Inline context received.')));
    const usage = record(await database.get('SELECT COUNT(*) AS count,SUM(total_tokens) AS tokens FROM pi_usage_events WHERE user_id=$1 AND session_id=$2 AND agent_id=$3 AND workspace_id=$4 AND provider=$5 AND model=$6',
      [fixture.actorId, run.sessionId, run.agentId, run.workspaceId, fixture.model.providerId, fixture.model.modelId])); assert(Number(usage.count) >= 2 && Number(usage.tokens) > 0);
  } finally { await database.close(); }
  const scope = { userId: fixture.actorId };
  const { requireMcpUserAccess, assertPersonalMcpConnectionMetadataAccess } = await import('../../app/lib/mcp/access');
  const { readExistingConfig } = await import('../../app/lib/mcp/read-only-config');
  const { resolveMcpConfigPath } = await import('../../app/lib/mcp/config');
  const { getMcpOAuthStatus } = await import('../../app/lib/mcp/oauth');
  const mcpActor = await requireMcpUserAccess(scope); assert(mcpActor);
  const mcpConfig = await readExistingConfig(resolveMcpConfigPath(scope)); const completed = new Set<string>();
  for (const reference of [run.mcpRef, run.standaloneMcpRef]) {
    const matches = Object.entries(mcpConfig.mcpServers).filter(([, value]) => `mcp-personal:${value.connectionId}` === reference); assert.equal(matches.length, 1);
    const [name, config] = matches[0]; assert.equal(config.ownerUserId, fixture.actorId); assert.equal(config.url, fixture.mcpUrl); assert.notEqual(config.enabled, false);
    await assertPersonalMcpConnectionMetadataAccess(config, scope, mcpActor);
    const oauth = await getMcpOAuthStatus(name, fixture.baseURL, scope);
    assert(oauth.configured && oauth.requiresAuth && oauth.authorized && oauth.authStatus === 'authorized' && oauth.lastCompletedState);
    completed.add(oauth.lastCompletedState);
  }
  assert.equal(completed.size, 2, 'Both exact owned MCP connections require their own completed, currently bound OAuth setup.');
  let inline = 0, plain = 0;
  for (const clientMessageId of cids) {
    const identity = { userId: fixture.actorId, sessionId: run.sessionId, clientMessageId, expectedAgentId: run.agentId, expectedWorkspaceId: run.workspaceId };
    let owned = await readOwnedAcceptedChatMessage(identity); assert(owned); let snapshot = readOwnedChatMessageExecutionSnapshot(owned);
    const deadline = performance.now() + 15_000;
    while (!['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(snapshot.phase) && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200)); owned = await readOwnedAcceptedChatMessage(identity); assert(owned); snapshot = readOwnedChatMessageExecutionSnapshot(owned);
    }
    assert.equal(snapshot.phase, 'succeeded'); assert(snapshot.executionRevision >= 4 && snapshot.runtimeToken !== 'unclaimed');
    const payload = snapshot.payload; assert.equal(payload.identity.userId, fixture.actorId); assert.equal(payload.clientMessageId, clientMessageId);
    const saved = history.filter(row => row.role === 'user' && row.clientMessageId === clientMessageId); assert.equal(saved.length, 1);
    const message = saved[0]; same(message.content, payload.message.content); same(message.body ?? null, payload.body ?? null);
    assert.equal(message.timestamp, payload.message.timestamp); assert.equal(message.serverMessageId, payload.serverMessageId);
    const connection = await openDb();
    try {
      const receipts = await connection.all('SELECT payload_hash,private_payload FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1 AND client_message_id=$2', [sessionDbId, clientMessageId]) as Array<{ payload_hash: string; private_payload: string }>;
      assert.equal(receipts.length, 1); same(JSON.parse(receipts[0].private_payload), payload);
      assert.equal(receipts[0].payload_hash, canonicalAcceptedMessageIntentHash({ content: payload.message.content, context: payload.context, mode: payload.mode,
        selection: payload.extensionSelection?.publicSelection ?? null, ...(payload.body ? { body: payload.body } : {}) }));
    } finally { await connection.close(); }
    const text = typeof payload.message.content === 'string' ? payload.message.content : payload.message.content.filter(row => row.type === 'text').map(row => row.text).join('\n');
    let expectedSdkTurn: NativeExpectedSdkTurn;
    if (text.startsWith(`PLAIN-${run.marker}`)) {
      plain++; assertNativeRetypedSkillCaption(text, run.marker, run.skillCaption);
      assert.equal(payload.extensionSelection, null); assert(!payload.body?.bundles.length); if (payload.body) assertChatBodyContent(parseChatBody(payload.body), payload.message.content);
      expectedSdkTurn = { platform: run.platform, kind: 'plain', clientMessageId, ...nativeSqlUserTextFingerprint(payload.message.content),
        selectedPackages: [], selectedConnections: [] };
    } else {
      inline++; assert(text.startsWith(run.marker)); assert(payload.body && payload.extensionSelection);
      const body = parseChatBody(payload.body); assertChatBodyContent(body, payload.message.content); assert.equal(projectChatBodyText(body), text);
      assertChatBodySelection(body, payload.extensionSelection.publicSelection);
      assert.equal(body.parts.filter(part => part.type === 'extension_reference').length, 4); assert.equal(body.bundles.length, 4);
      const primary = body.bundles.map(bundle => bundle.primary.selection); same(primary.map(selection => selection.kind).sort(), ['composio', 'mcp', 'plugin', 'skill']);
      const plugin = body.bundles.find(bundle => bundle.primary.selection.kind === 'plugin')!, skill = body.bundles.find(bundle => bundle.primary.selection.kind === 'skill')!;
      assert(plugin.primary.selection.kind === 'plugin' && skill.primary.selection.kind === 'skill'); same(plugin.primary.selection.package, run.pluginPin); same(skill.primary.selection.package, run.skillPin);
      assert.equal(nativeExtensionSkillCaption(skillVersion.package, skill.primary.selection), run.skillCaption); assert.equal(skill.caption, run.skillCaption);
      const selectedMcp = primary.find(selection => selection.kind === 'mcp')!; assert(selectedMcp.kind === 'mcp' && selectedMcp.target.kind === 'personal'); assert.equal(selectedMcp.target.connectionRef, run.standaloneMcpRef); assert.notEqual(run.standaloneMcpRef, run.mcpRef);
      same(primary.find(selection => selection.kind === 'composio'), run.selectedAccount);
      assert.equal(plugin.packageConnections.length, 1); assert.equal(plugin.supporting.length, 1);
      const mapping = plugin.packageConnections[0]; same(mapping.package, run.pluginPin); assert(mapping.connectionSelection.kind === 'mcp' && mapping.connectionSelection.target.kind === 'personal'); assert.equal(mapping.connectionSelection.target.connectionRef, run.mcpRef);
      same(plugin.supporting[0].selection, mapping.connectionSelection);
      assert.equal(mapping.capabilityId, 'native-connection'); assert.equal(mapping.alternativeKey, `mcp:native-mcp-${fixture.nonce.slice(0, 10)}`);
      assert.equal(mapping.declarationPath, `skills/native-child-${fixture.nonce.slice(0, 10)}/agents/canvas.yaml`);
      const bindings = payload.extensionSelection.privateFixedBindings;
      assert.equal(bindings.length, 3);
      const actualMcpIds = bindings.flatMap(binding => binding.entry.target.kind === 'personal' && binding.entry.target.personalBinding.source === 'mcp'
        ? [`mcp-personal:${binding.entry.target.personalBinding.connectionId}`] : []);
      same(actualMcpIds.sort(), [run.mcpRef, run.standaloneMcpRef].sort());
      const selectedConnections = bindings.map(binding => {
        const target = binding.entry.target; assert(target.kind === 'personal' && target.ownerUserId === fixture.actorId && typeof target.boundProviderRef === 'string');
        return { source: target.source, providerRef: target.boundProviderRef };
      });
      expectedSdkTurn = { platform: run.platform, kind: 'inline', clientMessageId, ...nativeSqlUserTextFingerprint(payload.message.content),
        selectedPackages: [run.pluginPin, run.skillPin], selectedConnections };
    }
    const after = await readOwnedAcceptedChatMessage(identity); assert(after); same(readOwnedChatMessageExecutionSnapshot(after), snapshot);
    expectedSdkTurns.push(expectedSdkTurn);
  }
  assert.equal(inline, 1); assert.equal(plain, 1);
  const { inspectManagedAgent } = await import('../../app/lib/agents/management-actions');
  const { readManagedAgentWorkflow, inspectManagedAgentWorkflow } = await import('../../app/lib/agents/workflow-configuration');
  const actor = { userId: fixture.actorId, organizationId: process.env.CANVAS_ORGANIZATION_ID, workspaceId: run.workspaceId, source: 'api' as const };
  assert.equal(run.centralAgentSnapshots.before.agent.agentId, run.createdAgentId);
  assertNativeCentralAgentUnchanged(run.centralAgentSnapshots.before, run.centralAgentSnapshots.after);
  const inspected = await inspectManagedAgent(actor, run.createdAgentId, { purpose: 'configure' });
  assertNativeCentralAgentUnchanged(run.centralAgentSnapshots.before, projectNativeCentralAgentSnapshot(inspected));
  const descriptor = inspected.extensions, state = await readManagedAgentWorkflow(actor, run.createdAgentId);
  assert.equal(state.agent.name, `Native UI ${run.platform === 'android' ? 'Android' : 'iOS'} ${fixture.nonce.slice(0, 10)}`); assert(state.access.canEdit && state.access.canUse);
  assert.equal(descriptor.configurationState, 'available'); const configuration = descriptor.configuration; assert(configuration?.mode === 'fixed');
  assert(configuration.selections.some(entry => entry.selection.kind === 'skill' && (() => { try { same(entry.selection.package, run.skillPin); return true; } catch { return false; } })()));
  assert(configuration.selections.some(entry => entry.selection.kind === 'plugin' && (() => { try { same(entry.selection.package, run.pluginPin); return true; } catch { return false; } })()));
  const packages = state.bindings.flatMap(binding => binding.configuration ? [binding.configuration] : []);
  const pkg = packages.find(value => value.resourceRef === run.pluginPin.resourceRef); assert(pkg);
  same({ resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum }, run.pluginPin);
  assert.equal(pkg.skillSelection.kind, 'plugin'); same(pkg.selectedSkills.map(value => value.relativeRoot), [`skills/native-child-${fixture.nonce.slice(0, 10)}`]);
  assert.equal(pkg.declarations.length, 1); const declaration = pkg.declarations[0];
  assert.equal(declaration.declarationPath, `skills/native-child-${fixture.nonce.slice(0, 10)}/agents/canvas.yaml`); assert.equal(declaration.capabilities.length, 1);
  const capability = declaration.capabilities[0]; assert.equal(capability.capabilityId, 'native-connection'); assert.equal(capability.required, true);
  assert(capability.selection.mode === 'selectable'); const policy = capability.selection; assert.equal(policy.allowedChoices.length, 1);
  assert.equal(policy.defaultChoiceId, policy.allowedChoices[0].choiceId);
  const retained = policy.allowedChoices[0]; assert.equal(retained.alternativeKey, `mcp:native-mcp-${fixture.nonce.slice(0, 10)}`);
  assert(retained.target.kind === 'personal' && retained.target.ownerUserId === fixture.actorId && retained.target.personalBinding?.source === 'mcp');
  assert.equal(`mcp-personal:${retained.target.personalBinding.connectionId}`, run.mcpRef); same(retained.toolCap, run.packageMcpToolCap);
  same(policy.personalPolicy, { sources: ['composio'], alternativeKeys: ['composio:canva'], toolCap: null });
  assert(!JSON.stringify(policy).includes('accountSelectionRef'));
  assert.equal(configuration.standalone.length, 1); const central = configuration.standalone[0]; assert(central.mode === 'selectable' && central.source === 'composio' && central.toolkit === 'canva'
    && central.personalPolicy?.source === 'composio' && central.personalPolicy.toolkit === 'canva' && central.allowedChoices.length === 0);
  const preference = state.choices[run.capabilityKey]; assert(preference && preference.workflowRevision === state.workflowRevision && preference.personalTarget?.kind === 'personal');
  assert.equal(preference.personalTarget.ownerUserId, fixture.actorId); same(preference.standaloneSelection, run.selectedAccount); assert(state.preferenceRevision > 0);
  const workflow = await inspectManagedAgentWorkflow(actor, run.createdAgentId); const slot = workflow.standalone?.find(row => row.capabilityKey === run.capabilityKey);
  assert(slot && slot.selectionOrigin === 'user' && slot.selectedConnection?.availability === 'available');
  return { platform: run.platform, userMessages: 2, exactPackagePins: true, exactPersonalConnections: true, nativeAgentConfigurationAndOwnChoice: true,
    centralAgentConfigurationUnchanged: true };
}
/** Parent-side read-only acceptance. Native receipt flags alone never establish execution or persisted identity. */
export async function verifyChatExtensionNativeFixture(fixture: Fixture) {
  await ownedFixture(fixture);
  const proof = proofSchema.parse(JSON.parse((await bytes(path.join(fixture.root, 'chat-extension-native-ui-proof.json'))).toString('utf8')));
  assert.equal(proof.nonce, fixture.nonce); assert.equal(proof.actorId, fixture.actorId); same(proof.platforms.map(row => row.platform).sort(), ['android', 'ios']);
  assert.equal(new Set(proof.platforms.map(row => row.sessionId)).size, 2); await verifyNativeArtifacts(fixture, proof);
  const provider = record(JSON.parse((await bytes(path.join(fixture.root, 'provider-proof.json'))).toString('utf8'))), model = record(provider.model);
  assert(Array.isArray(model.completions) && model.completions.length === 4); assert.equal(model.forbiddenRequests, 0);
  const expectedSdkTurns: NativeExpectedSdkTurn[] = [], results = [];
  for (const run of proof.platforms) results.push(await verifyRun(fixture, run, expectedSdkTurns));
  const sdkCurrentTurnProofs = assertNativeSdkTurnProofs(model.completions, expectedSdkTurns);
  await ownedFixture(fixture);
  return { verified: true, results, sdkCurrentTurnProofs, actualNativeDevices: ['ios-simulator', 'android-emulator'], actualSqlHistory: true,
    controlledSdkTransport: true, externalLlm: false, physicalDeviceChecked: false };
}
