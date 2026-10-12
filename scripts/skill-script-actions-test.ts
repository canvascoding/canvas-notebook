import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentFileToolSuccess } from '../app/lib/pi/agent-file-tool-results';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-script-actions-'));
  const settings = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'script-actions-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', BASE_URL: 'http://localhost:3001', BETTER_AUTH_BASE_URL: 'http://localhost:3001',
    QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_MANAGED_SERVICES_ENABLED: 'false', COMPOSIO_ENABLED: 'false', NODE_ENV: 'test' };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const postgres = database.getPostgresRuntimeQueryable();
  type Transaction = Parameters<Parameters<typeof postgres.transaction>[0]>[0];
  // PGlite has one physical session. Its transaction API queues unrelated
  // queries; raw BEGIN calls on pretend clients would merge watcher/RPC TXs.
  database.openDb = async () => {
    let transaction: Transaction | null = null, completion: Promise<void> | null = null;
    let finish: ((failure?: Error) => void) | undefined;
    const begin = async (sql: string) => {
      if (completion) throw new Error('Nested fixture transactions are unavailable.');
      let resolveReady!: () => void, rejectReady!: (failure: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      completion = postgres.transaction(async held => {
        transaction = held;
        const options = sql.trim().slice(5).trim();
        if (options) await held.query(`SET TRANSACTION ${options}`);
        const ended = new Promise<Error | undefined>(resolve => { finish = resolve; });
        resolveReady();
        const failure = await ended;
        if (failure) throw failure;
      });
      void completion.then(() => { transaction = null; finish = undefined; }, failure => {
        transaction = null; finish = undefined; rejectReady(failure);
      });
      await ready;
    };
    const end = async (rollback: boolean) => {
      if (!completion || !finish) return { changes: 0 };
      const failure = rollback ? new Error('Fixture transaction rollback') : undefined;
      finish(failure);
      try { await completion; } catch (error) { if (error !== failure) throw error; }
      finally { completion = null; }
      return { changes: 0 };
    };
    const query = (sql: string, params: unknown[] = []) => (transaction ?? postgres).query(sql, params);
    return {
      get: async (sql: string, params?: unknown[]) => (await query(sql, params)).rows[0],
      all: async (sql: string, params?: unknown[]) => (await query(sql, params)).rows,
      run: async (sql: string, params?: unknown[]) => {
        if (/^BEGIN\b/iu.test(sql.trim())) { await begin(sql); return { changes: 0 }; }
        if (/^COMMIT\b/iu.test(sql.trim())) return end(false);
        if (/^ROLLBACK\b/iu.test(sql.trim())) return end(true);
        return { changes: (await query(sql, params)).affectedRows ?? 0 };
      },
      close: async () => { await end(true); },
    };
  };
  const leaseOne = await database.openDb(), leaseTwo = await database.openDb();
  try {
    await leaseOne.run('BEGIN'); await leaseOne.get('SELECT 1 AS value');
    let secondBegan = false;
    const waiting = leaseTwo.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').then(() => { secondBegan = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(secondBegan, false, 'Concurrent fixture transactions queue independently instead of nesting raw BEGIN in one session.');
    await leaseOne.run('COMMIT'); await waiting;
    assert.deepEqual(await leaseTwo.get('SELECT 2 AS value'), { value: 2 });
    await leaseTwo.run('COMMIT');
  } finally {
    await leaseOne.close(); await leaseTwo.close();
  }
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  let resetCollaborationDatabase: (() => void) | undefined;
  loader._load = (name, parent, mainModule) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    // No native tool, process, sandbox, permission, registry or file service is mocked.
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    if (name === '@/app/lib/pi/live-runtime' || name.endsWith('/pi/live-runtime.ts')) return { requestPiRuntimePromptRefreshForUser: async () => {} };
    return original(name, parent, mainModule);
  };
  try {
    const runner = await import('../app/lib/skills/script-runtime/process');
    for (const kind of ['node', 'python'] as const) {
      const readiness = await runner.probeSkillScriptRuntime({ runtime: { kind } });
      assert.equal(readiness.available, true, `Actual ${kind} host runtime blocker: ${readiness.code || 'unknown'} (${readiness.sandboxMode || 'unsupported sandbox'}).`);
    }
    for (const id of ['owner', 'alice', 'bob']) await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,banned,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,0,1,1)', [id, `${id}@script-actions.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('script-actions-org','owner','team',1,1,1)");
    for (const id of ['owner', 'alice', 'bob']) await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('script-actions-org',$1,$2,'active',$3,1,1)", [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
    for (const workspace of ['shared-team', 'alice-team', 'bob-team']) await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'script-actions-org','team',$2,$1,'active',1,1)", [workspace, `workspaces/${workspace}/files`]);
    for (const [workspace, user] of [['shared-team', 'owner'], ['alice-team', 'alice'], ['bob-team', 'bob']]) await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('script-actions-org',$1,$2,'member','active',1,1,0,1,1)", [workspace, user]);
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const resourceStore = await import('../app/lib/capabilities/resources/store');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const agents = await import('../app/lib/agents/registry');
    const toolsRegistry = await import('../app/lib/pi/tool-registry');
    const execution = await import('../app/lib/pi/agent-execution-context');
    const planning = await import('../app/lib/pi/planning-mode');
    const temporary = await import('../app/lib/pi/agent-runtime-temp');
    // This existing explicit DB-only seam also covers the collaboration
    // repository's native dynamic import, which bypasses the CJS loader seam.
    const collaborationDatabase = await import('../app/lib/files/collaboration-repository/transaction');
    collaborationDatabase.setFileCollaborationConnectionFactoryForTests(database.openDb);
    resetCollaborationDatabase = () => collaborationDatabase.setFileCollaborationConnectionFactoryForTests(null);
    const { DEFAULT_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
    const { piSessions } = await import('../app/lib/db/schema');
    const names = ['run_canvas_skill_script', 'list_canvas_skill_scripts', 'describe_canvas_skill_script', 'read'];
    for (const user of ['alice', 'bob']) await agents.createAgentProfile({ name: `${user} script specialist`, agentId: `${user}-script-agent`, scopeType: 'user',
      ownerUserId: user, organizationId: 'script-actions-org', createdByUserId: user, relevantSkills: ['actions-skill'], enabledTools: names });
    await agents.getAgentProfile(DEFAULT_MANAGED_AGENT_ID);
    for (const [sessionId, userId, agentId] of [['alice-script', 'alice', 'alice-script-agent'], ['bob-script', 'bob', 'bob-script-agent'],
      ['alice-next', 'alice', 'alice-script-agent'], ['alice-default', 'alice', DEFAULT_MANAGED_AGENT_ID]]) await database.db.insert(piSessions).values({
      sessionId, userId, agentId, workspaceId: `${userId}-team`, workspaceType: 'team', organizationId: 'script-actions-org', provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date(),
    });
    const source = path.join(root, 'source', 'actions-plugin'), child = path.join(source, 'skills/actions-skill');
    await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(child, '.canvas-skill'), { recursive: true });
    await fs.mkdir(path.join(child, 'scripts'));
    await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'actions-plugin', version: '1.0.0', description: 'Actual script action fixture', skills: './skills' }));
    await fs.writeFile(path.join(child, 'SKILL.md'), '---\nname: actions-skill\ndescription: Bounded native script workflow\nmetadata:\n  version: "1.0.0"\n---\n\nRun the selected entrypoint.\n');
    const nodeScript = (version: number) => `const fs = require('node:fs');\nconst sdk = require(process.env.CANVAS_SKILL_BRIDGE_MODULE);\n(async () => {\n const args = sdk.arguments();\n if (args.mode === 'symlink') { fs.symlinkSync(__filename, 'output.txt'); return; }\n if (args.mode === 'isolation') {\n  const blocked = [];\n  try { fs.readFileSync(args.otherPath); } catch (_) { blocked.push('direct'); }\n  await sdk.call('input', {path: args.inputPath});\n  fs.writeFileSync('output.txt', JSON.stringify(blocked)); return;\n }\n const schema = await sdk.describe('input');\n const value = await sdk.call('input', {path: args.inputPath});\n if (!schema.schemaHandle) throw new Error('schema missing');\n if (args.mode === 'delay') { fs.writeFileSync('ready', 'yes'); await new Promise(resolve => setTimeout(resolve, 1800)); }\n fs.writeFileSync('output.txt', JSON.stringify({version:${version},label:args.label,input:value.content,scratch:process.cwd()}));\n process.stdout.write('node-complete');\n})().catch(error => { process.stderr.write(error.code || 'failed'); process.exitCode = 1; });\n`;
    await fs.writeFile(path.join(child, 'scripts/main.js'), nodeScript(1));
    await fs.writeFile(path.join(child, 'scripts/main.py'), 'import json, os\nimport canvas_skill as sdk\nargs = sdk.arguments()\nschema = sdk.describe("input")\nvalue = sdk.call("input", {"path": args["inputPath"]})\nassert schema["schemaHandle"]\nwith open("output.txt", "w") as handle:\n json.dump({"version": 1, "label": args["label"], "input": value["content"], "scratch": os.getcwd()}, handle)\nprint("python-complete")\n');
    const argumentsSchema = { type: 'object', required: ['label', 'inputPath'], additionalProperties: false, properties: {
      label: { type: 'string' }, inputPath: { type: 'string' }, otherPath: { type: 'string' }, mode: { enum: ['normal', 'delay', 'isolation', 'symlink'] } } };
    await fs.writeFile(path.join(child, '.canvas-skill/runtime.json'), JSON.stringify({ version: 1, scripts: [
      ...(['node', 'python'] as const).map(runtime => ({ id: runtime, runtime: { kind: runtime }, path: runtime === 'node' ? 'scripts/main.js' : 'scripts/main.py', argumentsSchema,
        tools: [{ alias: 'input', kind: 'native', toolName: 'read' }], outputs: ['output.txt'] })),
      { id: 'unbound', runtime: { kind: 'node' }, path: 'scripts/main.js', argumentsSchema, tools: [{ alias: 'design', kind: 'integration', source: 'composio', application: 'canva', toolName: 'CANVA_GET_DESIGN' }], outputs: ['output.txt'] },
    ] }));
    const installed = await registry.installCanvasPluginFromPath(source, { scope: { scopeType: 'organization', organizationId: 'script-actions-org' }, enable: true, installedBy: 'owner' });
    assert(installed.success && installed.plugin?.resourceId, installed.error || 'Actual plugin installation failed.');
    const owner = { userId: 'owner', workspaceId: 'shared-team' };
    const adopted = await resources.configureCapabilityResource(owner, installed.plugin.resourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      ownership: { type: 'team', workspaceId: 'shared-team' }, accessMode: 'restricted', grants: ['alice', 'bob'].map(targetId => ({ targetType: 'user' as const, targetId, canUse: true, canEdit: false, canManage: false })) });
    const ref = adopted.metadata.resourceRef, descriptor = await packages.inspectCapabilityPackage(owner, ref);
    const initial = await packages.createCapabilityPackageDraftAction(owner, { operation: 'edit', resourceRef: ref, expectedMetadataRevision: descriptor.resource.metadataRevision,
      expectedGrantsRevision: descriptor.resource.grantsRevision, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const first = await packages.publishCapabilityPackageDraftAction(owner, { draftRef: initial.draftRef, expectedDraftRevision: initial.draftRevision,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const { setCapabilityPreference } = await import('../app/lib/capabilities/preference-store');
    for (const user of ['alice', 'bob']) await setCapabilityPreference({ userId: user, resourceId: installed.plugin.resourceId, enabled: true });
    const context = async (user: string, sessionId = `${user}-script`, agentId = `${user}-script-agent`) => ({
      ...await sessions.resolveAgentExecutionContextForSession({ userId: user, sessionId, agentId }), agentTurnId: `${sessionId}-turn` });
    const alice = await context('alice'), bob = await context('bob');
    for (const current of [alice, bob]) { await fs.mkdir(current.workspaceRoot, { recursive: true }); await fs.writeFile(path.join(current.workspaceRoot, 'input.txt'), `${current.userId}-private-input`); }
    const loadTools = (current: AgentExecutionContext) => toolsRegistry.getPiTools(current.userId, current.agentId, current.sessionId, { executionContext: current, strictAuthorization: true });
    const selected = await loadTools(alice);
    assert.deepEqual(selected.map(tool => tool.name).sort(), [...names].sort(), 'Actual explicit agent selection grants exactly the requested tool surface.');
    const invoke = async (current: AgentExecutionContext, toolName: string, params: unknown, cached?: AgentTool) => {
      const tool = cached ?? (await loadTools(current)).find(value => value.name === toolName);
      assert(tool, `Actual tool ${toolName} is assigned.`);
      const result = await execution.runWithAgentExecutionContext(current, () => tool.execute('actions-fixture', params as never));
      return { result, details: result.details as Record<string, unknown> };
    };
    const list = await invoke(alice, 'list_canvas_skill_scripts', {});
    assert.equal(list.details.error, undefined);
    const entries = list.details.scripts as Array<{ id: string; scriptRef: string; publishedRevisionRef: string; readiness: { available: boolean; code?: string; message?: string } }>;
    assert.equal(entries.length, 3); assert(entries.every(entry => entry.publishedRevisionRef === first.published.revisionRef));
    assert.equal(entries.find(entry => entry.id === 'node')!.readiness.available, true);
    assert.equal(entries.find(entry => entry.id === 'unbound')!.readiness.code, 'SCRIPT_TOOL_DENIED');
    const nodeRef = entries.find(entry => entry.id === 'node')!.scriptRef;
    const describe = await invoke(alice, 'describe_canvas_skill_script', { scriptRef: nodeRef });
    assert.equal((describe.details.script as { publishedRevisionRef: string }).publishedRevisionRef, first.published.revisionRef);
    const defaultContext = await context('alice', 'alice-default', DEFAULT_MANAGED_AGENT_ID), defaultTools = await loadTools(defaultContext);
    assert(!defaultTools.some(tool => tool.name === 'run_canvas_skill_script'), 'Run is disabled by default.');
    const defaultList = await invoke(defaultContext, 'list_canvas_skill_scripts', {});
    assert((defaultList.details.scripts as typeof entries).every(entry => !entry.readiness.available && entry.readiness.message));
    const planningTools = planning.filterToolsForPlanningMode(selected);
    assert(planningTools.some(tool => tool.name === 'list_canvas_skill_scripts') && planningTools.some(tool => tool.name === 'describe_canvas_skill_script'));
    assert(!planningTools.some(tool => tool.name === 'run_canvas_skill_script'));
    const run = (current: AgentExecutionContext, scriptRef: string, destinationPath: string, extra: Record<string, unknown> = {}, outputExtra: Record<string, unknown> = {}) => invoke(current, 'run_canvas_skill_script', {
      scriptRef, arguments: { label: current.userId, inputPath: 'input.txt', ...extra }, outputs: [{ sourcePath: 'output.txt', destinationPath, ...outputExtra }] });
    const actualRead = await invoke(alice, 'read', { path: 'input.txt' });
    assert.equal(actualRead.details.error, undefined, JSON.stringify(actualRead.details));
    const assertSuccess = async (current: AgentExecutionContext, response: Awaited<ReturnType<typeof run>>, destination: string, version: number) => {
      assert.equal(response.details.success, true, JSON.stringify(response.details));
      const files = response.details.files as AgentFileToolSuccess[];
      assert.equal(files.length, 1); assert.equal(files[0].contractVersion, 1); assert.equal(files[0].kind, 'file_mutation');
      assert.equal(files[0].path, destination); assert.equal(files[0].safeToAutoRetry, false); assert(!Object.hasOwn(files[0], 'resolvedPath'));
      assert(['applied', 'review_required'].includes(files[0].outcome));
      assert.equal(files[0].outcome, 'applied', 'A new fixture output is actually written; reviewed existing outputs have separate receipts.');
      const bytes = await fs.readFile(path.join(current.workspaceRoot, destination));
      assert.equal(files[0].afterSha256, createHash('sha256').update(bytes).digest('hex'));
      const payload = JSON.parse(bytes.toString()) as { version: number; label: string; input: unknown; scratch: string };
      assert.equal(payload.version, version); assert.equal(payload.label, current.userId); assert(JSON.stringify(payload.input).includes(`${current.userId}-private-input`));
      assert(payload.scratch.startsWith(await fs.realpath(temporary.resolveAgentRuntimeTempDir(current))));
      return payload;
    };
    const aliceOutput = await assertSuccess(alice, await run(alice, nodeRef, 'alice-node.json'), 'alice-node.json', 1);
    const bobEntries = (await invoke(bob, 'list_canvas_skill_scripts', {})).details.scripts as typeof entries;
    const bobOutput = await assertSuccess(bob, await run(bob, bobEntries.find(entry => entry.id === 'python')!.scriptRef, 'bob-python.json'), 'bob-python.json', 1);
    assert.notEqual(aliceOutput.scratch, bobOutput.scratch);
    assert.equal((await fs.stat(aliceOutput.scratch).catch(() => null)), null, 'Completed private scratch is cleaned.');
    const repeatedRead = await invoke(alice, 'read', { path: 'input.txt' });
    assert.equal(repeatedRead.details.error, undefined, JSON.stringify(repeatedRead.details));
    const isolated = await run(alice, nodeRef, 'isolation.json', { mode: 'isolation', otherPath: path.join(bob.workspaceRoot, 'input.txt') });
    assert.equal(isolated.details.success, true, JSON.stringify(isolated.details));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(alice.workspaceRoot, 'isolation.json'), 'utf8')), ['direct'], 'OS confinement denies the other actor workspace.');
    const foreignRead = await invoke(bob, 'read', { path: path.join(alice.workspaceRoot, 'alice-node.json') });
    assert(foreignRead.details.error, 'The actual native read tool independently denies another actor output.');
    const oldTool = selected.find(tool => tool.name === 'run_canvas_skill_script')!;
    const cloned = await invoke(JSON.parse(JSON.stringify(alice)), 'run_canvas_skill_script', { scriptRef: nodeRef, arguments: { label: 'alice', inputPath: 'input.txt' } });
    assert.equal(cloned.details.error, true, 'Serialized package receipts cannot execute.');
    const { createSkillScriptTools } = await import('../app/lib/pi/skill-script-tools');
    const direct = createSkillScriptTools(alice.userId, alice.agentId, alice.sessionId).find(tool => tool.name === 'run_canvas_skill_script')!;
    const wrong = await execution.runWithAgentExecutionContext(bob, () => direct.execute('wrong-actor', { scriptRef: nodeRef, arguments: {} } as never));
    assert.equal((wrong.details as { error: boolean }).error, true);
    const noAuthority = await direct.execute('no-authority', { scriptRef: nodeRef, arguments: {} } as never);
    assert.equal((noAuthority.details as { error: boolean }).error, true);
    const invalid = await invoke(alice, 'run_canvas_skill_script', { scriptRef: nodeRef, arguments: { label: 1, inputPath: 'input.txt' } });
    assert.equal(invalid.details.code, 'SCRIPT_ARGUMENTS_INVALID');
    const missing = await run(alice, entries.find(entry => entry.id === 'unbound')!.scriptRef, 'missing-binding.json');
    assert.equal(missing.details.code, 'SCRIPT_TOOL_DENIED');
    const symlink = await run(alice, nodeRef, 'symlink.json', { mode: 'symlink' });
    assert.equal(symlink.details.code, 'SCRIPT_OUTPUT_INVALID');
    assert.equal(await fs.stat(path.join(alice.workspaceRoot, 'symlink.json')).catch(() => null), null);
    const originalBytes = await fs.readFile(path.join(alice.workspaceRoot, 'alice-node.json'));
    const stale = await run(alice, nodeRef, 'alice-node.json', {}, { overwrite: true, expectedSha256: '0'.repeat(64) });
    assert.equal(stale.details.error, true); assert.deepEqual(await fs.readFile(path.join(alice.workspaceRoot, 'alice-node.json')), originalBytes);

    const current = await packages.inspectCapabilityPackage(owner, ref);
    let nextDraft = await packages.createCapabilityPackageDraftAction(owner, { operation: 'edit', resourceRef: ref,
      expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
      expectedPackageRevision: current.state!.packageRevision, expectedPublishedRevisionRef: current.state!.currentPublishedRevisionRef });
    nextDraft = (await packages.writeCapabilityPackageDraftFileAction(owner, nextDraft.draftRef, { expectedDraftRevision: nextDraft.draftRevision, path: 'skills/actions-skill/scripts/main.js', encoding: 'base64', content: Buffer.from(nodeScript(2)).toString('base64') })).draft;
    await packages.publishCapabilityPackageDraftAction(owner, { draftRef: nextDraft.draftRef, expectedDraftRevision: nextDraft.draftRevision,
      expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
      expectedPackageRevision: current.state!.packageRevision, expectedPublishedRevisionRef: current.state!.currentPublishedRevisionRef });
    await assertSuccess(alice, await run(alice, nodeRef, 'held-v1.json'), 'held-v1.json', 1);
    const next = await context('alice', 'alice-next'), nextEntries = (await invoke(next, 'list_canvas_skill_scripts', {})).details.scripts as typeof entries;
    await assertSuccess(next, await run(next, nextEntries.find(entry => entry.id === 'node')!.scriptRef, 'new-v2.json'), 'new-v2.json', 2);

    const delayed = run(alice, nodeRef, 'revoked-write.json', { mode: 'delay' });
    const scratch = temporary.resolveAgentRuntimeTempDir(alice);
    let observed = false;
    for (let attempt = 0; attempt < 800 && !observed; attempt++) {
      for (const entry of await fs.readdir(scratch)) if (entry.startsWith('skill-script-') && await fs.stat(path.join(scratch, entry, 'ready')).catch(() => null)) observed = true;
      if (!observed) await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!observed) await delayed;
    assert(observed, 'Actual running script reached the output wait before the permission change.');
    await raw.run("UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id='alice-team' AND user_id='alice'");
    const revokedWrite = await delayed;
    assert.equal(revokedWrite.details.code, 'SCRIPT_ACCESS_DENIED', JSON.stringify(revokedWrite.details));
    assert.equal(await fs.stat(path.join(alice.workspaceRoot, 'revoked-write.json')).catch(() => null), null);
    await raw.run("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id='alice-team' AND user_id='alice'");
    await agents.updateAgentProfile({ agentId: 'alice-script-agent', enabledTools: names.filter(name => name !== 'run_canvas_skill_script') });
    const withdrawn = await invoke(alice, 'run_canvas_skill_script', { scriptRef: nodeRef, arguments: { label: 'alice', inputPath: 'input.txt' }, outputs: [{ sourcePath: 'output.txt', destinationPath: 'withdrawn.json' }] }, oldTool);
    assert.equal(withdrawn.details.code, 'SCRIPT_TOOL_DENIED');
    assert.equal(await fs.stat(path.join(alice.workspaceRoot, 'withdrawn.json')).catch(() => null), null);
    await agents.updateAgentProfile({ agentId: 'alice-script-agent', enabledTools: names });
    await resourceStore.mutateCapabilityResource(owner, ref, { expectedMetadataRevision: adopted.metadata.metadataRevision, expectedGrantsRevision: adopted.metadata.grantsRevision,
      grants: [{ targetType: 'user', targetId: 'bob', canUse: true, canEdit: false, canManage: false }] });
    const revokedUse = await run(alice, nodeRef, 'revoked-use.json');
    assert.equal(revokedUse.details.error, true);
    assert.equal(await fs.stat(path.join(alice.workspaceRoot, 'revoked-use.json')).catch(() => null), null);
    console.log('PASS actual PGlite + package/session/agent registry + native read + restricted Node/Python actions: separate actors/scratch/outputs, default/planning, immutable v1, private proof, schema/bindings/links, file receipts/revisions and live workspace/tool/resource revocation.');
  } finally {
    resetCollaborationDatabase?.(); loader._load = original;
    await raw.close(); await database.close();
    async function unlock(directory: string): Promise<void> {
      const stat = await fs.lstat(directory); if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) { await fs.chmod(directory, 0o700); for (const entry of await fs.readdir(directory)) await unlock(path.join(directory, entry)); }
    }
    await unlock(root); await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
