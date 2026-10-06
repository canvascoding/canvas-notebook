import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NextRequest } from 'next/server';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-resource-access-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'resource-org',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const database = await createPiTestDatabase();
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  let authenticatedUser = 'alice';
  const shellCalls: Array<{ context: { skillReadRoots?: readonly string[] } }> = [];
  internals._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    // HTTP authentication is represented by its trusted server user; all membership,
    // workspace, package, grant and policy authorization below remains real.
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: authenticatedUser } }) } } };
    if (name === 'next/headers') return { headers: async () => new Headers() };
    if (name === '@/app/lib/pi/agent-shell-sandbox') return { executeAgentSandboxedProcess: async (_command: unknown, options: { context: { skillReadRoots?: readonly string[] } }) => {
      shellCalls.push(options); return { stdout: 'fixture', stderr: '' };
    } };
    if (name === '@earendil-works/pi-agent-core' || name === '@earendil-works/pi-ai/oauth') return {};
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [{ id: 'fixture-model', name: 'Fixture model', provider: 'openrouter', api: 'openai-completions',
        input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      getProviders: () => ['openrouter'], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    return originalLoad(name, parent, isMain);
  };
  try {
    const raw = await database.openDb();
    for (const id of ['owner', 'alice', 'bob', 'charlie']) await raw.run(
      'INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,1,1)', [id, `${id}@example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('resource-org','owner','team',1,1,1)");
    for (const id of ['owner', 'alice', 'bob', 'charlie']) await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('resource-org',$1,$2,'active',$3,1,1)",
      [id, id === 'owner' ? 'owner' : 'member', id === 'owner' ? 1 : 0]);
    for (const id of ['team-a', 'team-b']) await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'resource-org','team',$2,$1,'active',1,1)", [id, `workspaces/${id}/files`]);
    for (const [id, workspace] of [['alice', 'team-a'], ['bob', 'team-a'], ['bob', 'team-b'], ['charlie', 'team-a']]) await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('resource-org',$1,$2,'member','active',1,0,0,1,1)", [workspace, id]);
    const { installCanvasPluginFromPath } = await import('../app/lib/plugins/canvas-plugin-registry');
    const packageRoot = async (label: string, name: string, child: string, body: string, requiredMcp = false) => {
      const location = path.join(root, 'packages', label);
      await mkdir(path.join(location, '.canvas-plugin'), { recursive: true });
      await mkdir(path.join(location, 'skills', child, 'scripts'), { recursive: true });
      await writeFile(path.join(location, '.canvas-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0', description: body, skills: './skills',
        ...(requiredMcp ? { connectors: { mcp: [{ name: 'resource-mcp', required: true }] } } : {}) }));
      await writeFile(path.join(location, 'skills', child, 'SKILL.md'), `---\nname: ${child}\ndescription: ${body}\nmetadata:\n  version: "1.0.0"\n---\n\n${body}\n`);
      await writeFile(path.join(location, 'skills', child, 'scripts/operation.ts'), `// ${body}\n`);
      return location;
    };
    const org = { scopeType: 'organization' as const, organizationId: 'resource-org' };
    const orgInstall = await installCanvasPluginFromPath(await packageRoot('org', 'protected-design', 'protected-skill', 'ORG_PRIVATE_BODY'), { scope: org, enable: true, installedBy: 'owner' });
    const shadow = await installCanvasPluginFromPath(await packageRoot('shadow', 'protected-design', 'protected-skill', 'PERSONAL_SHADOW_BODY'), { scope: { userId: 'alice' }, enable: false });
    const shared = await installCanvasPluginFromPath(await packageRoot('shared', 'bob-design', 'bob-design-skill', 'SHARED_SELECTED_BODY', true), { scope: { userId: 'bob' }, enable: true });
    const privateOther = await installCanvasPluginFromPath(await packageRoot('private', 'bob-private', 'bob-private-skill', 'FOREIGN_UNSHARED_BODY'), { scope: { userId: 'bob' }, enable: true });
    const legacySystem = await installCanvasPluginFromPath(await packageRoot('legacy', 'legacy-design', 'legacy-design-skill', 'LEGACY_PUBLIC_BODY'),
      { scope: { scopeType: 'system' }, enable: true });
    assert(orgInstall.success && shadow.success && shared.success && privateOther.success);
    assert.equal(legacySystem.success, true, legacySystem.error || 'System fixture installation failed.');
    // Historical global records are returned by the existing user legacy
    // registry fallback. Keep the real installed system package and its ID.
    const { writeCanvasPluginRegistry } = await import('../app/lib/plugins/canvas-plugin-registry');
    await writeCanvasPluginRegistry({ version: 1, updatedAt: '2026-10-06T00:00:00.000Z',
      plugins: { 'legacy-design': legacySystem.plugin! } });
    const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: { 'resource-mcp': { url: 'http://127.0.0.1:1/never-discover', enabled: true } } }), { userId: 'alice' });
    const { loadCapabilityCandidates, resolveEffectiveCapabilitySnapshot, loadEffectiveSkills } = await import('../app/lib/capabilities/catalog');
    const { capabilityResourceStorageBinding } = await import('../app/lib/capabilities/resources/storage-binding');
    const { adoptCapabilityResource, mutateCapabilityResource } = await import('../app/lib/capabilities/resources/store');
    const { resolveReadableCapabilityCandidate, readReadableCapabilityPlugin, assertReadableCapabilityCandidate } = await import('../app/lib/capabilities/resources/read');
    const { selectBrowsableSkillCandidates, resolveCapabilitySkillFile } = await import('../app/lib/skills/capability-skill-browser');
    const { getEffectiveSkillReadRoots } = await import('../app/lib/skills/effective-skill-read-roots');
    const alice = { userId: 'alice', workspaceId: 'team-a' };
    const bob = { userId: 'bob', workspaceId: 'team-a' };
    const owner = { userId: 'owner', workspaceId: 'team-a' };
    const context = { ...alice, organizationId: 'resource-org', role: 'member' };
    const rawOwner = await loadCapabilityCandidates({ ...context, userId: 'owner', role: 'owner' }, { applyResourceAccess: false, resolveConnections: false });
    const orgCandidate = rawOwner.find(entry => entry.ref.resourceType === 'plugin' && entry.ref.name === 'protected-design')!;
    const restrictedOrg = await adoptCapabilityResource(owner, capabilityResourceStorageBinding(orgCandidate.ref), {
      ownership: { type: 'team', organizationId: 'resource-org', workspaceId: 'team-a' },
      accessMode: 'restricted', grants: [], expectedMetadataRevision: 0, expectedGrantsRevision: 0,
    });
    const snapshot = await resolveEffectiveCapabilitySnapshot(context);
    const protectedEntry = snapshot.capabilities.find(entry => entry.ref.resourceId === orgCandidate.ref.resourceId)!;
    assert.equal(protectedEntry.runtimePath, null);
    assert.equal(protectedEntry.resourceAccess?.canRead, false);
    assert.equal(protectedEntry.effectiveEnabled, false);
    const shadowEntry = snapshot.capabilities.find(entry => entry.ref.name === 'protected-design' && entry.ref.scopeType === 'user')!;
    assert.equal(shadowEntry.readiness, 'conflict', 'An unreadable org resource still prevents personal shadow activation.');
    assert(!selectBrowsableSkillCandidates(snapshot.capabilities, 'user').some(entry => entry.ref.name === 'protected-skill'));
    const { GET: earlyTreeGet } = await import('../app/api/skills/tree/route');
    const hiddenTree = await earlyTreeGet(new NextRequest('http://fixture/api/skills/tree?workspaceId=team-a&depth=2'));
    assert.equal(hiddenTree.status, 200);
    assert(!(await hiddenTree.json()).data.some((entry: { name: string }) => entry.name === 'protected-skill'),
      'A denied org child reserves its namespace before unavailable paths are filtered.');
    await assert.rejects(readReadableCapabilityPlugin(alice, { resourceId: restrictedOrg.metadata.resourceRef }), /not found/i);
    assert(!getEffectiveSkillReadRoots({ snapshot }).some(location => location.includes('protected-skill')));
    const bobRaw = await loadCapabilityCandidates({ ...context, userId: 'bob' }, { applyResourceAccess: false, resolveConnections: false });
    const bobCandidate = bobRaw.find(entry => entry.ref.resourceType === 'plugin' && entry.ref.name === 'bob-design')!;
    const privateChild = bobRaw.find(entry => entry.ref.resourceType === 'skill' && entry.ref.name === 'bob-private-skill')!;
    const adopted = await adoptCapabilityResource(bob, capabilityResourceStorageBinding(bobCandidate.ref), { accessMode: 'restricted',
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }],
      expectedMetadataRevision: 0, expectedGrantsRevision: 0 });
    const { writeEnabledSkillsForScope } = await import('../app/lib/skills/skill-settings');
    const beforeActivation = await resolveEffectiveCapabilitySnapshot(context);
    assert.equal(beforeActivation.capabilities.find(entry => entry.ref.name === 'bob-design-skill')?.effectiveEnabled, false,
      'A new grant does not broaden an existing recipient skill whitelist.');
    await writeEnabledSkillsForScope(['bob-design-skill'],
      { scope: { userId: 'alice' }, updatedBy: 'alice' });
    const sharedSnapshot = await resolveEffectiveCapabilitySnapshot(context);
    const selected = await readReadableCapabilityPlugin(alice, { resourceId: adopted.metadata.resourceRef });
    assert.equal(selected.candidate.ref.ownerUserId, 'bob');
    assert.equal(selected.plugin.name, 'bob-design');
    assert(!sharedSnapshot.capabilities.some(entry => entry.ref.name.startsWith('bob-private')), 'No other package from the shared owner is appended.');
    const { GET: pluginsGet } = await import('../app/api/plugins/route');
    const { GET: skillsGet } = await import('../app/api/skills/route');
    const { GET: treeGet } = await import('../app/api/skills/tree/route');
    const sharedListResponse = await pluginsGet(new NextRequest('http://fixture/api/plugins?workspaceId=team-a'));
    assert.equal(sharedListResponse.status, 200);
    const sharedList = await sharedListResponse.json();
    const publicShared = sharedList.plugins.find((entry: { name: string }) => entry.name === 'bob-design');
    assert.equal(publicShared.resourceMetadata.resourceRef, adopted.metadata.resourceRef);
    assert.equal(publicShared.resourceAccess.canUse, true);
    assert.equal(publicShared.installDir, '');
    assert.equal(publicShared.skills[0].path, '', 'Shared resource lists do not reveal the owner filesystem.');
    assert.doesNotMatch(JSON.stringify(sharedList), /FOREIGN_UNSHARED_BODY|ORG_PRIVATE_BODY|PERSONAL_SHADOW_BODY/,
      'Public lists hide denied namespace owners and never resurrect the personal shadow.');
    const sharedChild = sharedSnapshot.capabilities.find(entry => entry.ref.name === 'bob-design-skill')!;
    const { inspectCapabilityResource } = await import('../app/lib/capabilities/resources/actions');
    const inspectedSharedChild = await inspectCapabilityResource(alice, sharedChild.ref.resourceId);
    assert.deepEqual(sharedChild.resourceMetadata?.ownership, adopted.metadata.ownership,
      'Shared personal children inherit the governed user owner and organization association.');
    assert.deepEqual(sharedChild.resourceMetadata, inspectedSharedChild.metadata,
      'Catalog and agent inspection use the same child metadata contract.');
    await assert.rejects(inspectCapabilityResource(alice, privateChild.ref.resourceId), /unavailable|not found/i,
      'Exact reference lookup never grants access to an unshared foreign child.');
    assert.equal(sharedChild.enabled, true, 'The explicit native skill preference enables the selected shared child.');
    assert.equal(sharedChild.resourceAccess?.canUse, true);
    assert.equal(sharedChild.resourceAccess?.canEdit, false);
    const resolved = await resolveCapabilitySkillFile(sharedSnapshot.capabilities, { resourceId: sharedChild.ref.resourceId, relativePath: 'scripts/operation.ts' });
    assert.match(await readFile(resolved.filePath, 'utf8'), /SHARED_SELECTED_BODY/);
    assert((await loadEffectiveSkills(sharedSnapshot)).some(skill => skill.name === 'bob-design-skill'));
    const { buildReferencedPluginRuntimeContext } = await import('../app/lib/plugins/plugin-reference-context');
    assert.match((await buildReferencedPluginRuntimeContext('/bob-design', { userId: 'alice' }, { workspaceId: 'team-a' })) || '', /SHARED_SELECTED_BODY/,
      'Runtime references include only the exact authorized foreign personal package.');
    const registryPath = path.join(root, 'store-registry.json');
    await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, id: 'resource-store', name: 'Resource fixture', updatedAt: '2026-10-06T00:00:00.000Z', plugins: [
      { name: 'protected-design', displayName: 'Protected', description: 'Public catalog', latestVersion: '1.0.0', versions: { '1.0.0': { version: '1.0.0', downloadUrl: 'https://example.test/org.zip', checksum: 'a'.repeat(64) } } },
      { name: 'bob-design', displayName: 'Shared', description: 'Public catalog', latestVersion: '1.0.0', versions: { '1.0.0': { version: '1.0.0', downloadUrl: 'https://example.test/shared.zip', checksum: 'b'.repeat(64) } } },
      { name: 'legacy-design', displayName: 'Legacy', description: 'Public catalog', latestVersion: '1.0.0', versions: { '1.0.0': { version: '1.0.0', downloadUrl: 'https://example.test/legacy.zip', checksum: 'c'.repeat(64) } } },
    ] }));
    const previousStoreUrl = process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL;
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = pathToFileURL(registryPath).href;
    const { GET: storeGet } = await import('../app/api/plugins/store/route');
    const storeResponse = await storeGet(new NextRequest('http://fixture/api/plugins/store?workspaceId=team-a'));
    assert.equal(storeResponse.status, 200);
    const storeBody = await storeResponse.json();
    assert.deepEqual(storeBody.installedPlugins.map((entry: { name: string }) => entry.name), ['bob-design']);
    assert.doesNotMatch(JSON.stringify(storeBody), /ORG_PRIVATE_BODY|PERSONAL_SHADOW_BODY|FOREIGN_UNSHARED_BODY/);
    authenticatedUser = 'charlie';
    const legacyList = await pluginsGet(new NextRequest('http://fixture/api/plugins?workspaceId=team-a'));
    assert.equal(legacyList.status, 200);
    const systemRecord = (await legacyList.json()).plugins.find((entry: { name: string }) => entry.name === 'legacy-design');
    assert(systemRecord, 'Existing global system fallback packages remain visible in the installed list.');
    assert.equal(systemRecord.scopeType, 'system');
    assert.equal(systemRecord.resourceAccess.canRead, true);
    assert.equal(systemRecord.resourceAccess.canEdit, false);
    assert.equal(systemRecord.resourceAccess.canManage, false);
    const legacyRead = await readReadableCapabilityPlugin({ userId: 'charlie', workspaceId: 'team-a' }, { resourceId: systemRecord.resourceId });
    assert.equal(legacyRead.plugin.name, 'legacy-design');
    const legacyStore = await storeGet(new NextRequest('http://fixture/api/plugins/store?workspaceId=team-a'));
    assert.equal(legacyStore.status, 200);
    assert.deepEqual((await legacyStore.json()).installedPlugins.map((entry: { name: string }) => entry.name), ['legacy-design'],
      'Existing global system fallback packages preserve the Store installed state.');
    authenticatedUser = 'alice';
    if (previousStoreUrl === undefined) delete process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL;
    else process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = previousStoreUrl;
    const { DEFAULT_AGENT_ID } = await import('../app/lib/channels/constants');
    const { getAgentProfile } = await import('../app/lib/agents/registry');
    const { piSessions } = await import('../app/lib/db/schema');
    const { resolveAgentExecutionContextForSession } = await import('../app/lib/pi/session-workspace-context');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { assertAgentPathAllowed } = await import('../app/lib/pi/agent-file-operations');
    await getAgentProfile(DEFAULT_AGENT_ID);
    await database.db.insert(piSessions).values({ sessionId: 'resource-session', userId: 'alice', agentId: DEFAULT_AGENT_ID,
      workspaceId: 'team-a', workspaceType: 'team', organizationId: 'resource-org', provider: 'fixture', model: 'fixture',
      createdAt: new Date(), updatedAt: new Date() });
    const runningContext = await resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'resource-session', agentId: DEFAULT_AGENT_ID });
    await runWithAgentExecutionContext(runningContext, () => assertAgentPathAllowed(resolved.filePath));
    const { resolveFreshAgentSkillReadRoots } = await import('../app/lib/skills/fresh-agent-skill-read-roots');
    assert((await resolveFreshAgentSkillReadRoots(runningContext)).includes(path.dirname(sharedChild.runtimePath!)),
      'A previously ready package with a required MCP connection remains readable without provider discovery.');
    const { executeAgentBashCommand } = await import('../app/lib/pi/agent-bash-runtime');
    const { ensureAgentRuntimeTempDir } = await import('../app/lib/pi/agent-runtime-temp');
    await mkdir(runningContext.workspaceRoot, { recursive: true });
    const tempDir = await ensureAgentRuntimeTempDir(runningContext);
    const launcher = path.join(root, 'landlock-fixture');
    await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const shellEnvironment = { CANVAS_AGENT_BASH_SANDBOX: process.env.CANVAS_AGENT_BASH_SANDBOX,
      CANVAS_AGENT_LANDLOCK_PATH: process.env.CANVAS_AGENT_LANDLOCK_PATH };
    const bashInput = { command: 'true', cwd: tempDir, workspaceDir: runningContext.workspaceRoot,
      tempDir, env: { NODE_ENV: 'test' as const }, executionContext: runningContext };
    for (const mode of ['local-development', 'required']) {
      process.env.CANVAS_AGENT_BASH_SANDBOX = mode;
      process.env.CANVAS_AGENT_LANDLOCK_PATH = launcher;
      await executeAgentBashCommand(bashInput);
    }
    assert.equal(shellCalls.length, 2, 'Both shell start paths receive fresh approved roots.');
    await assert.rejects(resolveReadableCapabilityCandidate(alice, { resourceType: 'plugin', name: 'bob-design' }), /not found/i);
    const next = await mutateCapabilityResource(bob, adopted.metadata.resourceRef, { grants: [],
      expectedMetadataRevision: adopted.metadata.metadataRevision, expectedGrantsRevision: adopted.metadata.grantsRevision });
    assert.equal(next.metadata.resourceRef, adopted.metadata.resourceRef);
    await assert.rejects(assertReadableCapabilityCandidate(alice, selected.candidate, selected.candidates), /not found/i);
    await assert.rejects(loadEffectiveSkills(sharedSnapshot), /unavailable/i, 'Earlier runtime snapshots do not survive live grant revocation.');
    await assert.rejects(runWithAgentExecutionContext(runningContext, () => assertAgentPathAllowed(resolved.filePath)),
      /unavailable|limited|restricted|denied/i, 'A running agent cannot keep reading a shared package through previously captured roots after revocation.');
    for (const mode of ['local-development', 'required']) {
      process.env.CANVAS_AGENT_BASH_SANDBOX = mode;
      await assert.rejects(executeAgentBashCommand(bashInput), /Skill access is unavailable/);
    }
    assert.equal(shellCalls.length, 2, 'Revoked roots prevent both shell launch paths from invoking any process.');
    for (const [key, value] of Object.entries(shellEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(await buildReferencedPluginRuntimeContext('/bob-design', { userId: 'alice' }, { workspaceId: 'team-a' }), null);
    await assert.rejects(inspectCapabilityResource(alice, sharedChild.ref.resourceId), /unavailable|not found/i,
      'A previously listed child reference stops resolving when its parent grant is revoked.');
    assert(!(await loadCapabilityCandidates(context, { resolveConnections: false })).some(entry => entry.ref.name === 'bob-design'));
    const editOnly = await mutateCapabilityResource(owner, restrictedOrg.metadata.resourceRef, {
      grants: [{ targetType: 'user', targetId: 'alice', canUse: false, canEdit: true, canManage: false }],
      expectedMetadataRevision: restrictedOrg.metadata.metadataRevision, expectedGrantsRevision: restrictedOrg.metadata.grantsRevision });
    assert.equal(editOnly.metadata.resourceRef, restrictedOrg.metadata.resourceRef);
    const readOnlySnapshot = await resolveEffectiveCapabilitySnapshot(context);
    const orgChild = readOnlySnapshot.capabilities.find(entry => entry.ref.name === 'protected-skill')!;
    assert.equal(orgChild.resourceAccess?.canRead, true);
    assert.equal(orgChild.resourceAccess?.canUse, false);
    assert.equal(orgChild.effectiveEnabled, false, 'Plugin-child activation never restores denied execution.');
    const readOnlySkills = await skillsGet(new NextRequest('http://fixture/api/skills?workspaceId=team-a'));
    assert.equal(readOnlySkills.status, 200);
    const readOnlySkillBody = await readOnlySkills.json();
    const publicReadOnlyChild = readOnlySkillBody.skills.find((entry: { name: string }) => entry.name === 'protected-skill');
    assert.equal(publicReadOnlyChild.resourceAccess.canRead, true);
    assert.equal(publicReadOnlyChild.resourceAccess.canUse, false);
    assert.equal(publicReadOnlyChild.enabled, false);
    const inspectedTeamChild = await inspectCapabilityResource(alice, orgChild.ref.resourceId);
    assert.deepEqual(inspectedTeamChild.metadata.ownership, { type: 'team', organizationId: 'resource-org', workspaceId: 'team-a' });
    assert.deepEqual(orgChild.resourceMetadata, inspectedTeamChild.metadata);
    assert.deepEqual(publicReadOnlyChild.resourceMetadata, inspectedTeamChild.metadata,
      'Team owner and parent revisions are identical in catalog, public skills and agent inspection.');
    assert.equal(publicReadOnlyChild.resourceMetadata.metadataRevision, editOnly.metadata.metadataRevision);
    assert.equal(publicReadOnlyChild.resourceMetadata.grantsRevision, editOnly.metadata.grantsRevision);
    assert.equal(publicReadOnlyChild.resourceMetadata.resourceRef, orgChild.ref.resourceId,
      'The bundled child keeps its own stable resource identity.');
    const treeResponse = await treeGet(new NextRequest('http://fixture/api/skills/tree?workspaceId=team-a&depth=2'));
    assert.equal(treeResponse.status, 200);
    assert((await treeResponse.json()).data.some((entry: { name: string }) => entry.name === 'protected-skill'),
      'Read access exposes the package tree without granting runtime execution.');
    const { GET: fileGet } = await import('../app/api/skills/file/route');
    const response = await fileGet(new NextRequest(`http://fixture/api/skills/file?workspaceId=team-a&resourceId=${encodeURIComponent(orgChild.ref.resourceId)}&path=scripts/operation.ts`));
    assert.equal(response.status, 200);
    assert.match((await response.json()).content, /ORG_PRIVATE_BODY/);
    authenticatedUser = 'bob';
    const denied = await fileGet(new NextRequest(`http://fixture/api/skills/file?workspaceId=team-a&resourceId=${encodeURIComponent(orgChild.ref.resourceId)}&path=scripts/operation.ts`));
    assert.equal(denied.status, 404);
    assert.doesNotMatch(await denied.text(), /ORG_PRIVATE_BODY/);
    console.log('PASS actual PG + installed packages: resource read/use separation, org namespace reservation, exact shared personal loading, child inheritance, fresh grant revocation and guarded HTTP file reads.');
  } finally {
    internals._load = originalLoad;
    await database.close();
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
