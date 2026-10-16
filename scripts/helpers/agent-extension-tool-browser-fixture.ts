import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { agentExtensionConfigurationInputSchema, extensionPackagePinSchema } from '../../app/lib/capabilities/extensions/contracts';

export type AgentExtensionToolBrowserFixture = {
  root: string; nonce: string; actorId: string; dataRoot: string; databaseName: string; baseURL: string;
  toolAgent?: { agentId: string; agentName: string; sessionId: string };
};
const identifier = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const preparedSchema = z.object({ version: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{32}$/u), actorId: identifier, agentId: identifier,
  agentName: identifier, sessionId: identifier, before: z.object({ revision: revision.refine(value => value > 0),
    workflowRevision: revision.refine(value => value > 0) }).strict() }).strict();
const proofSchema = z.object({ version: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{32}$/u), actorId: identifier, agentId: identifier,
  sessionId: identifier.optional(), before: z.object({ revision: revision, workflowRevision: revision }).strict(),
  after: z.object({ revision: revision, workflowRevision: revision, name: identifier }).strict(),
  packagePins: z.array(extensionPackagePinSchema).min(1).max(32),
  mcpConnectionRefs: z.array(z.string().regex(/^(?:mcp-personal|canvas-connection):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)).min(1).max(32),
}).strict();
const inspectionSchema = z.object({ agent: z.object({ agentId: identifier, name: identifier, revision: revision,
  workflowRevision: revision, workflowVersion: z.literal(2), scopeType: z.literal('user'), ownerUserId: identifier,
  enabledTools: z.array(identifier).nullable() }),
  extensions: z.object({ configurationState: z.literal('available'), configuration: agentExtensionConfigurationInputSchema,
    revision, workflowRevision: revision }) });

async function privateFile(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size <= 65_536,
    'The tool/browser fixture requires its own bounded private regular file.');
  return fs.readFile(file, 'utf8');
}

/** Fences fixture IO to the runner's actual nonce database and owned directory. Never creates grants or runtime authority. */
async function assertOwnedFixture(fixture: AgentExtensionToolBrowserFixture): Promise<void> {
  assert.match(fixture.nonce, /^[a-f0-9]{32}$/u);
  assert(identifier.safeParse(fixture.actorId).success);
  assert(path.isAbsolute(fixture.root) && fixture.root === await fs.realpath(fixture.root));
  const stat = await fs.lstat(fixture.root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700);
  assert.equal(fixture.dataRoot, path.join(fixture.root, 'data'));
  assert.equal(await fs.realpath(fixture.dataRoot), fixture.dataRoot);
  assert.equal(process.env.DATA, fixture.dataRoot); assert.equal(process.env.CANVAS_DATA_ROOT, fixture.dataRoot);
  assert.equal(process.env.PLUGIN_EXTENSION_E2E_ROOT, fixture.root);
  assert.equal(process.env.PLUGIN_EXTENSION_E2E_NONCE, fixture.nonce);
  assert.equal(fixture.databaseName, `canvas_plugin_extension_test_${fixture.nonce}`);
  const database = new URL(process.env.DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(database.protocol) && database.hostname === '127.0.0.1'
    && database.port === '55433' && !database.search && !database.hash);
  assert.equal(database.pathname, `/${fixture.databaseName}`);
  assert.equal(fixture.baseURL, 'http://127.0.0.1:3001'); assert.equal(process.env.BASE_URL, fixture.baseURL);
  const marker = await privateFile(path.join(fixture.root, '.fixture-owner'));
  assert.match(marker, /^[a-f0-9]{48}$/u);
  const receipt = JSON.parse(await privateFile(path.join(fixture.root, 'recovery.json'))) as Record<string, unknown>;
  assert.equal(receipt.version, 1); assert.equal(receipt.nonce, fixture.nonce); assert.equal(receipt.actorId, fixture.actorId);
  assert.equal(receipt.fixtureRoot, fixture.root); assert.equal(receipt.dataRoot, fixture.dataRoot);
  assert.equal(receipt.databaseName, fixture.databaseName); assert.equal(receipt.ownerMarker, marker);
  assert.equal(receipt.createAcknowledged, true); assert.equal(receipt.databaseDropped, false); assert.equal(receipt.uncertain, false);
  assert.equal(receipt.rootDevice, String(stat.dev)); assert.equal(receipt.rootInode, String(stat.ino));
  const { openDb } = await import('../../app/lib/db');
  const connection = await openDb();
  try {
    const identity = await connection.get('SELECT current_database() AS name, current_user AS role') as { name: string; role: string };
    assert.equal(identity.name, fixture.databaseName);
    const owner = await connection.get("SELECT pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
      [fixture.databaseName]) as { owner: string; marker: string };
    assert.equal(owner.owner, identity.role); assert.equal(owner.marker, marker);
    const user = await connection.get('SELECT id,role FROM "user" WHERE id=$1', [fixture.actorId]) as { id: string; role: string } | undefined;
    assert(user && user.id === fixture.actorId && user.role === 'admin', 'The actual isolated owner is required.');
  } finally { await connection.close(); }
}

function identities(fixture: AgentExtensionToolBrowserFixture) {
  return { agentId: `tool-browser-${fixture.nonce.slice(0, 12)}`, agentName: `Tool browser ${fixture.nonce.slice(0, 10)}`,
    sessionId: `tool-browser-session-${fixture.nonce}` };
}

async function inspectToolAgent(fixture: AgentExtensionToolBrowserFixture) {
  const expected = identities(fixture);
  const { DEFAULT_MANAGED_AGENT_ID } = await import('../../app/lib/agents/storage');
  const { resolveAgentExecutionContextForStoredSession } = await import('../../app/lib/pi/session-workspace-context');
  const { runWithAgentExecutionContext } = await import('../../app/lib/pi/agent-execution-context');
  const { createAgentManagementTools } = await import('../../app/lib/pi/agent-management-tools');
  const context = await resolveAgentExecutionContextForStoredSession({ userId: fixture.actorId,
    sessionId: expected.sessionId, agentId: DEFAULT_MANAGED_AGENT_ID });
  const inspect = createAgentManagementTools(fixture.actorId, DEFAULT_MANAGED_AGENT_ID, expected.sessionId).find(tool => tool.name === 'inspect_agent');
  assert(inspect, 'The actual inspect_agent tool must be registered.');
  const response = await runWithAgentExecutionContext(context, () => inspect.execute(`tool-browser-inspect-${fixture.nonce}`, {
    agentId: expected.agentId, purpose: 'configure', includeFiles: false, includeAccess: false,
  }));
  const inspection = inspectionSchema.parse(response.details);
  assert.equal(inspection.agent.agentId, expected.agentId); assert.equal(inspection.agent.ownerUserId, fixture.actorId);
  assert.equal(inspection.extensions.revision, inspection.agent.revision);
  assert.equal(inspection.extensions.workflowRevision, inspection.agent.workflowRevision);
  assert.equal(inspection.extensions.configuration.mode, 'fixed');
  return inspection;
}

/** Real SQL session + workspace resolver + actual create_agent/inspect_agent. No model, API facade or manufactured context. */
export async function prepareAgentExtensionToolBrowserFixture(fixture: AgentExtensionToolBrowserFixture) {
  await assertOwnedFixture(fixture);
  const expected = identities(fixture);
  const { db } = await import('../../app/lib/db');
  const { piSessions } = await import('../../app/lib/db/schema');
  const { ensureCanvasAgent } = await import('../../app/lib/agents/registry');
  const { resolveAgentSessionWorkspaceForUser, workspaceToPiSessionFields, resolveAgentExecutionContextForStoredSession } = await import('../../app/lib/pi/session-workspace-context');
  const { runWithAgentExecutionContext } = await import('../../app/lib/pi/agent-execution-context');
  const { createAgentManagementTools } = await import('../../app/lib/pi/agent-management-tools');
  const main = await ensureCanvasAgent();
  const workspace = await resolveAgentSessionWorkspaceForUser({ userId: fixture.actorId });
  // This session drives direct metadata/configuration tools only. Provider/model
  // markers are inert persisted fixture fields, never a fabricated runnable model
  // selection or a runtime proof. The real stored-session resolver owns authority.
  await db.insert(piSessions).values({ sessionId: expected.sessionId, userId: fixture.actorId, agentId: main.agentId,
    provider: 'metadata-fixture-not-executed', model: 'metadata-fixture-not-executed', title: 'Tool/UI configuration acceptance',
    ...workspaceToPiSessionFields(workspace), createdAt: new Date(), updatedAt: new Date() });
  const context = await resolveAgentExecutionContextForStoredSession({ userId: fixture.actorId, sessionId: expected.sessionId, agentId: main.agentId });
  const create = createAgentManagementTools(fixture.actorId, main.agentId, expected.sessionId).find(tool => tool.name === 'create_agent');
  assert(create, 'The actual create_agent tool must be registered.');
  const result = await runWithAgentExecutionContext(context, () => create.execute(`tool-browser-create-${fixture.nonce}`, {
    agentId: expected.agentId, name: expected.agentName, scopeType: 'user', enabledTools: ['read'],
    extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] },
  }));
  const created = inspectionSchema.parse(result.details);
  assert.equal(created.agent.agentId, expected.agentId); assert.equal(created.agent.name, expected.agentName);
  const inspected = await inspectToolAgent(fixture);
  assert.equal(inspected.agent.revision, created.agent.revision, 'The fresh inspection must equal the actual Create acknowledgement.');
  assert.equal(inspected.agent.workflowRevision, created.agent.workflowRevision, 'The fresh workflow revision must equal the actual Create acknowledgement.');
  assert.equal(inspected.agent.name, expected.agentName); assert.deepEqual(inspected.agent.enabledTools, ['read']);
  const configuration = inspected.extensions.configuration;
  assert(configuration.mode === 'fixed' && !configuration.selections.length && !configuration.standalone.length
    && !(configuration.workflow?.packages.length), 'The actual tool creates the complete empty fixed configuration.');
  const prepared = preparedSchema.parse({ version: 1, nonce: fixture.nonce, actorId: fixture.actorId, ...expected,
    before: { revision: created.agent.revision, workflowRevision: created.agent.workflowRevision } });
  await fs.writeFile(path.join(fixture.root, 'agent-tool-prepare-receipt.json'), JSON.stringify(prepared), { mode: 0o600, flag: 'wx' });
  return expected;
}

/** Browser records explicit expected edits; a fresh real inspect_agent verifies the other transport independently. */
export async function verifyAgentExtensionToolBrowserFixture(fixture: AgentExtensionToolBrowserFixture) {
  await assertOwnedFixture(fixture);
  const expected = identities(fixture);
  assert.deepEqual(fixture.toolAgent, expected, 'The runner must hold its own exact prepared tool-agent identity.');
  const proof = proofSchema.parse(JSON.parse(await privateFile(path.join(fixture.root, 'agent-tool-browser-proof.json'))));
  assert.equal(proof.nonce, fixture.nonce); assert.equal(proof.actorId, fixture.actorId); assert.equal(proof.agentId, expected.agentId);
  if (proof.sessionId !== undefined) assert.equal(proof.sessionId, expected.sessionId);
  const prepared = preparedSchema.parse(JSON.parse(await privateFile(path.join(fixture.root, 'agent-tool-prepare-receipt.json'))));
  assert.equal(prepared.nonce, fixture.nonce); assert.equal(prepared.actorId, fixture.actorId);
  assert.equal(prepared.agentId, expected.agentId); assert.equal(prepared.agentName, expected.agentName); assert.equal(prepared.sessionId, expected.sessionId);
  assert.deepEqual(proof.before, prepared.before, 'The browser must start from exactly the actual acknowledged Tool Create revisions.');
  assert(proof.after.revision > proof.before.revision && proof.after.workflowRevision > proof.before.workflowRevision);
  assert.notEqual(proof.after.name, expected.agentName, 'The browser must actually edit the prepared profile too.');
  const inspected = await inspectToolAgent(fixture);
  assert.equal(inspected.agent.name, proof.after.name); assert.equal(inspected.agent.revision, proof.after.revision);
  assert.equal(inspected.agent.workflowRevision, proof.after.workflowRevision);
  assert.deepEqual(inspected.agent.enabledTools, ['read'], 'The extension editor must preserve the tool-created native tool limit.');
  const configuration = inspected.extensions.configuration;
  assert(configuration.mode === 'fixed');
  const pinKey = (pin: z.infer<typeof extensionPackagePinSchema>) => JSON.stringify([pin.resourceRef, pin.publishedRevisionRef, pin.checksum]);
  const actualPins = (configuration.workflow?.packages ?? []).map(pinKey).sort();
  const expectedPins = proof.packagePins.map(pinKey).sort();
  assert.equal(new Set(expectedPins).size, expectedPins.length, 'The browser proof must not repeat a published pin.');
  assert.deepEqual(actualPins, expectedPins, 'inspect_agent must return exactly the immutable package pins selected in the browser.');
  const actualSelections = configuration.selections.flatMap(entry => entry.selection.kind === 'plugin' || entry.selection.kind === 'skill' ? [pinKey(entry.selection.package)] : []);
  assert.deepEqual([...new Set(actualSelections)].sort(), expectedPins);
  const actualMcpRefs = configuration.standalone.flatMap(slot => slot.mode === 'fixed' && slot.entry.selection.kind === 'mcp'
    ? [slot.entry.selection.target.connectionRef] : []).sort();
  assert.equal(new Set(proof.mcpConnectionRefs).size, proof.mcpConnectionRefs.length);
  assert.deepEqual(actualMcpRefs, [...proof.mcpConnectionRefs].sort(), 'inspect_agent must preserve the exact browser-selected MCP identities.');
  assert.equal(configuration.standalone.length, actualMcpRefs.length, 'No unrelated standalone selection may be added.');
  return { agentId: expected.agentId, sessionId: expected.sessionId, revision: inspected.agent.revision,
    workflowRevision: inspected.agent.workflowRevision, packageCount: actualPins.length, mcpCount: actualMcpRefs.length };
}
