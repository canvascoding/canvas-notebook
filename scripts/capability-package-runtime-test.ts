import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft } from '../app/lib/capabilities/packages/contracts';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-package-runtime-'));
  const settings = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'held-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', BETTER_AUTH_BASE_URL: 'http://localhost:3000', QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false' };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  const launches: unknown[] = [];
  loader._load = (name, parent, mainModule) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    // Provider execution is not part of this package gate. All source, user,
    // session, workspace, grant, policy and revision authorization remains real.
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    if (name === '@/app/lib/pi/live-runtime' || name.endsWith('/pi/live-runtime.ts')) return { requestPiRuntimePromptRefreshForUser: async () => {} };
    if (name === '@/app/lib/pi/agent-shell-sandbox') return { executeAgentSandboxedProcess: async (_command: unknown, options: unknown) => {
      launches.push(options); return { stdout: 'fixture', stderr: '' };
    } };
    return original(name, parent, mainModule);
  };
  try {
    for (const id of ['owner', 'alice', 'outsider']) await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,banned,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,0,1,1)', [id, `${id}@held.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('held-org','owner','team',1,1,1)");
    for (const id of ['owner', 'alice', 'outsider']) await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('held-org',$1,$2,'active',$3,1,1)", [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('held-team','held-org','team','workspaces/held-team/files','Held team','active',1,1)");
    for (const id of ['owner', 'alice', 'outsider']) await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('held-org','held-team',$1,'member','active',1,0,0,1,1)", [id]);
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const resourceStore = await import('../app/lib/capabilities/resources/store');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const catalog = await import('../app/lib/capabilities/catalog');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const execution = await import('../app/lib/pi/agent-execution-context');
    const fresh = await import('../app/lib/skills/fresh-agent-skill-read-roots');
    const fileAccess = await import('../app/lib/pi/agent-file-operations');
    const agents = await import('../app/lib/agents/registry');
    const { DEFAULT_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
    const { piSessions } = await import('../app/lib/db/schema');
    const source = path.join(root, 'source', 'held-plugin');
    await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true });
    await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'held-plugin', version: '1.0.0', description: 'Complete held package', skills: './skills' }));
    for (const name of ['held-first', 'held-second']) {
      await fs.mkdir(path.join(source, 'skills', name, 'scripts'), { recursive: true });
      await fs.mkdir(path.join(source, 'skills', name, 'assets'));
      await fs.writeFile(path.join(source, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Exact held version\nmetadata:\n  version: "1.0.0"\n---\n\nBody version-one ${name}.\n`);
      await fs.writeFile(path.join(source, 'skills', name, 'scripts/main.js'), `process.stdout.write('version-one-${name}');\n`);
      await fs.writeFile(path.join(source, 'skills', name, 'assets/image.bin'), Buffer.from([1, 0, 255]));
    }
    const scope = { scopeType: 'organization' as const, organizationId: 'held-org' };
    const installed = await registry.installCanvasPluginFromPath(source, { scope, enable: true, installedBy: 'owner' });
    assert(installed.success && installed.plugin?.resourceId, installed.error || 'The actual plugin installation failed.');
    const owner = { userId: 'owner', workspaceId: 'held-team' }, alice = { userId: 'alice', workspaceId: 'held-team' };
    const adopted = await resources.configureCapabilityResource(owner, installed.plugin.resourceId, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'team', workspaceId: 'held-team' }, accessMode: 'restricted',
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }],
    });
    const ref = adopted.metadata.resourceRef;
    const edit = (descriptor: CapabilityPackageDescriptor) => ({ operation: 'edit' as const, resourceRef: ref,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state?.packageRevision ?? 0, expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const publish = (draft: CapabilityPackageDraft, descriptor: CapabilityPackageDescriptor) => ({ draftRef: draft.draftRef,
      expectedDraftRevision: draft.draftRevision, expectedMetadataRevision: descriptor.resource.metadataRevision,
      expectedGrantsRevision: descriptor.resource.grantsRevision, expectedPackageRevision: descriptor.state?.packageRevision ?? 0,
      expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const descriptor = await packages.inspectCapabilityPackage(owner, ref);
    const initialDraft = await packages.createCapabilityPackageDraftAction(owner, edit(descriptor));
    const first = await packages.publishCapabilityPackageDraftAction(owner, publish(initialDraft, descriptor));
    const { setCapabilityPreference } = await import('../app/lib/capabilities/preference-store');
    await setCapabilityPreference({ userId: 'alice', resourceId: installed.plugin.resourceId, enabled: true });
    await agents.getAgentProfile(DEFAULT_MANAGED_AGENT_ID);
    await agents.createAgentProfile({ name: 'Held specialist', agentId: 'held-specialist', scopeType: 'user', ownerUserId: 'alice', organizationId: 'held-org', createdByUserId: 'alice', relevantSkills: ['held-first'] });
    for (const [sessionId, agentId] of [['held-parent', DEFAULT_MANAGED_AGENT_ID], ['held-child', 'held-specialist'], ['held-next', DEFAULT_MANAGED_AGENT_ID]]) await database.db.insert(piSessions).values({
      sessionId, userId: 'alice', agentId, workspaceId: 'held-team', workspaceType: 'team', organizationId: 'held-org', provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date(),
    });
    const held = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'held-parent', agentId: DEFAULT_MANAGED_AGENT_ID });
    assert.equal(held.skillPackageBindings?.length, 2, 'Both selected children use issued v1 receipts.');
    assert(held.skillPackageBindings!.every(binding => binding.publishedRevisionRef === first.published.revisionRef));
    const heldFirst = held.skillPackageBindings!.find(binding => binding.skillName === 'held-first')!;
    const heldRoot = path.dirname(heldFirst.runtimePath), script = path.join(heldRoot, 'scripts/main.js');
    assert(held.skillReadRoots!.includes(heldRoot));
    const managedPrompt = await import('../app/lib/agents/system-prompt');
    const {resolveEffectiveExtensionContext, readEffectiveExtensionContext} = await import('../app/lib/capabilities/extensions/effective-context');
    const {appendEffectiveExtensionContextPrompt, EFFECTIVE_EXTENSION_FOUNDATION_MARKER} = await import('../app/lib/capabilities/extensions/runtime-prompt');
    const {piTools} = await import('../app/lib/pi/core-tools');
    const {wrapToolWithExecutionContext} = await import('../app/lib/pi/tool-runtime-helpers');
    const actualRead = piTools.find(tool => tool.name === 'read'); assert(actualRead);
    const prompt = await managedPrompt.loadManagedAgentSystemPrompt(DEFAULT_MANAGED_AGENT_ID, { userId: 'alice', organizationId: 'held-org', workspaceId: 'held-team' }, { executionContext: held });
    assert(prompt.systemPrompt.includes(EFFECTIVE_EXTENSION_FOUNDATION_MARKER));
    assert(!prompt.systemPrompt.includes(heldFirst.runtimePath), 'The stored foundation has no second inherited skill index.');
    const generalFinal = appendEffectiveExtensionContextPrompt(prompt.systemPrompt, held, [actualRead], 'held-first');
    assert(!generalFinal.includes(heldFirst.runtimePath), 'Task ranking never injects an optional unselected plugin child into a general agent.');
    const explicitHeld = await resolveEffectiveExtensionContext({...held, turnExtensions: {version: 1, origin: 'turn_reference', selections: [{
      requirement: 'required', toolCap: null, selection: {kind: 'plugin', package: {resourceRef: ref,
        publishedRevisionRef: first.published.revisionRef, checksum: first.published.checksum}, skillSelection: {kind: 'all'}}}]}});
    const explicitFoundation = await managedPrompt.loadManagedAgentSystemPrompt(DEFAULT_MANAGED_AGENT_ID, { userId: 'alice', organizationId: 'held-org', workspaceId: 'held-team' }, {executionContext: explicitHeld});
    assert(explicitFoundation.systemPrompt.includes(EFFECTIVE_EXTENSION_FOUNDATION_MARKER));
    const explicitFinal = appendEffectiveExtensionContextPrompt(explicitFoundation.systemPrompt, explicitHeld, [actualRead], 'held-first');
    assert(explicitFinal.includes(heldFirst.runtimePath), 'The actual issued explicit plugin context and read recipe use the same held version path.');
    assert.throws(() => appendEffectiveExtensionContextPrompt(prompt.systemPrompt, structuredClone(explicitHeld), [actualRead]), {code: 'AGENT_EXTENSION_CONTEXT_DENIED'});
    const explicitRead = wrapToolWithExecutionContext(actualRead, explicitHeld);
    const readResult = await explicitRead.execute('held-explicit-read', {path: heldFirst.runtimePath});
    assert(JSON.stringify(readResult.content).includes('Body version-one held-first.'));

    const current = await packages.inspectCapabilityPackage(owner, ref);
    let nextDraft = await packages.createCapabilityPackageDraftAction(owner, edit(current));
    for (const name of ['held-first', 'held-second']) {
      const result = await packages.writeCapabilityPackageDraftFileAction(owner, nextDraft.draftRef, { expectedDraftRevision: nextDraft.draftRevision,
        path: `skills/${name}/scripts/main.js`, encoding: 'base64', content: Buffer.from(`process.stdout.write('version-two-${name}');\n`).toString('base64') });
      nextDraft = result.draft;
    }
    const second = await packages.publishCapabilityPackageDraftAction(owner, publish(nextDraft, current));
    const next = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'held-next', agentId: DEFAULT_MANAGED_AGENT_ID });
    assert(next.skillPackageBindings!.every(binding => binding.publishedRevisionRef === second.published.revisionRef));
    const skillLoader = await import('../app/lib/skills/skill-loader');
    const latestLoaded = await execution.runWithAgentExecutionContext(held, () => skillLoader.loadSkillsFromDisk(undefined, { ...scope, userId: 'alice' }));
    assert.equal(latestLoaded.find(skill => skill.name === 'held-first')?.path, next.skillPackageBindings!.find(binding => binding.skillName === 'held-first')?.runtimePath,
      'Metadata loading resolves the current immutable child rather than the retained stale materialized standalone.');
    assert((await fresh.resolveFreshAgentSkillReadRoots(held)).includes(heldRoot), 'Publishing v2 does not replace or revoke an issued v1.');
    await execution.runWithAgentExecutionContext(held, () => fileAccess.assertAgentPathAllowed(script));
    assert.match(await fs.readFile(script, 'utf8'), /version-one/u);
    assert.deepEqual(await fs.readFile(path.join(heldRoot, 'assets/image.bin')), Buffer.from([1, 0, 255]));
    const freshChild = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'held-child', agentId: 'held-specialist' });
    const child = await runtime.reissueCapabilityPackageRuntimeBindings(held, freshChild);
    assert.equal(child.skillPackageBindings?.length, 1, 'Specialized child retains only its current selected skill.');
    assert.equal(child.skillPackageBindings![0].publishedRevisionRef, first.published.revisionRef);
    assert(!child.skillReadRoots!.some(rootPath => rootPath.endsWith('held-second')));
    await fresh.revalidateAgentBashSkillReadRoots(child);
    const compiledChild = await resolveEffectiveExtensionContext(child, {preserveIssuedBindings: true});
    assert.equal(compiledChild.skillPackageBindings?.length, 1);
    assert.equal(compiledChild.skillPackageBindings![0].publishedRevisionRef, first.published.revisionRef);
    assert.equal(compiledChild.skillPackageBindings![0].runtimePath, heldFirst.runtimePath);
    assert(compiledChild.skillReadRoots!.includes(heldRoot));
    const currentChildPath = freshChild.skillPackageBindings!.find(binding => binding.skillName === 'held-first')!.runtimePath;
    assert.notEqual(currentChildPath, heldFirst.runtimePath, 'The actual child was initially resolved against the newer published head.');
    assert(!compiledChild.skillReadRoots!.includes(path.dirname(currentChildPath)), 'Preserving an issued source never keeps the fresh V2 read root.');
    assert.notEqual(compiledChild.effectiveExtensions, held.effectiveExtensions, 'The child receives a new opaque proof for its own session.');
    const compiledChildData = readEffectiveExtensionContext(compiledChild); assert(compiledChildData);
    const compiledChildSkill = compiledChildData.skills.find(skill => skill.name === 'held-first'); assert(compiledChildSkill);
    assert.equal(compiledChildSkill.runtimePath, heldFirst.runtimePath);
    assert.equal(compiledChildSkill.package?.publishedRevisionRef, first.published.revisionRef);
    assert.equal(compiledChildSkill.package?.checksum, first.published.checksum);
    const childFinal = appendEffectiveExtensionContextPrompt(EFFECTIVE_EXTENSION_FOUNDATION_MARKER, compiledChild, [actualRead], 'held-first');
    assert(childFinal.includes(heldFirst.runtimePath)); assert(!childFinal.includes(currentChildPath));
    const childRead = await wrapToolWithExecutionContext(actualRead, compiledChild).execute('held-child-preserved-read', {path: script});
    assert(JSON.stringify(childRead.content).includes('version-one-held-first'));
    assert(!JSON.stringify(childRead.content).includes('version-two-held-first'), 'The fresh native read still opens the delegated V1 bytes.');
    const cloned = JSON.parse(JSON.stringify(held));
    assert.equal((await runtime.reissueCapabilityPackageRuntimeBindings(cloned, freshChild)).skillPackageBindings?.length, 0, 'JSON strings cannot reissue a private server receipt.');
    assert(!(await fresh.resolveFreshAgentSkillReadRoots(cloned)).some(rootPath => rootPath.includes('/capability-packages/published/')));
    const updatedPrompt = await managedPrompt.loadManagedAgentSystemPrompt(DEFAULT_MANAGED_AGENT_ID, { userId: 'alice', organizationId: 'held-org', workspaceId: 'held-team' }, { executionContext: held });
    assert(updatedPrompt.systemPrompt.includes(EFFECTIVE_EXTENSION_FOUNDATION_MARKER));
    assert(!updatedPrompt.systemPrompt.includes(heldFirst.runtimePath));
    assert(!updatedPrompt.systemPrompt.includes(next.skillPackageBindings![0].runtimePath));
    const retainedFinal = appendEffectiveExtensionContextPrompt(explicitFoundation.systemPrompt, explicitHeld, [actualRead], 'held-first');
    assert(retainedFinal.includes(heldFirst.runtimePath));
    assert(!retainedFinal.includes(next.skillPackageBindings![0].runtimePath), 'A new publication cannot rewrite the exact issued turn context.');

    const childDescriptor = (await resources.listCapabilityResources(alice)).find(value => value.artifact.resourceType === 'skill' && value.artifact.name === 'held-first')!;
    const childPackage = await packages.inspectCapabilityPackage(alice, childDescriptor.metadata.resourceRef);
    const fork = await packages.createCapabilityPackageDraftAction(alice, { operation: 'fork', resourceRef: childPackage.resource.resourceRef,
      targetName: 'held-personal-fork', ownership: { type: 'user' }, expectedSourceMetadataRevision: childPackage.resource.metadataRevision,
      expectedSourceGrantsRevision: childPackage.resource.grantsRevision, expectedSourcePackageRevision: childPackage.state?.packageRevision ?? 0,
      expectedSourcePublishedRevisionRef: childPackage.state?.currentPublishedRevisionRef ?? null });
    const forked = await packages.publishCapabilityPackageDraftAction(alice, { draftRef: fork.draftRef, expectedDraftRevision: fork.draftRevision,
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const initialForkCatalog = await catalog.resolveEffectiveCapabilitySnapshot({ ...alice, organizationId: 'held-org', role: 'member' });
    assert.equal(initialForkCatalog.capabilities.find(candidate => candidate.ref.name === 'held-personal-fork')?.effectiveEnabled, false,
      'A published standalone fork remains installed and disabled until explicitly activated.');
    const forkCandidate = initialForkCatalog.capabilities.find(candidate => candidate.ref.name === 'held-personal-fork')!;
    const { withCapabilityPolicyStore } = await import('../app/lib/capabilities/policy-store');
    const required = await withCapabilityPolicyStore(store => store.upsertPolicy({ organizationId: 'held-org', resourceType: 'skill',
      resourceId: forkCandidate.ref.resourceId, targetType: 'user', targetId: 'alice', effect: 'required', actorUserId: 'owner', expectedRevision: 0 }));
    const requiredCatalog = await catalog.resolveEffectiveCapabilitySnapshot({ ...alice, organizationId: 'held-org', role: 'member' });
    assert.equal(requiredCatalog.capabilities.find(candidate => candidate.ref.name === 'held-personal-fork')?.effectiveEnabled, true,
      'Required policy can activate a disabled fork while fresh ownership grants still apply.');
    const blocked = await withCapabilityPolicyStore(store => store.upsertPolicy({ organizationId: 'held-org', resourceType: 'skill',
      resourceId: forkCandidate.ref.resourceId, targetType: 'user', targetId: 'alice', effect: 'blocked', actorUserId: 'owner', expectedRevision: required.revision }));
    const { writeEnabledSkillsForScope } = await import('../app/lib/skills/skill-settings');
    await writeEnabledSkillsForScope(['held-personal-fork'], { scope: { userId: 'alice' }, updatedBy: 'alice' });
    const blockedCatalog = await catalog.resolveEffectiveCapabilitySnapshot({ ...alice, organizationId: 'held-org', role: 'member' });
    assert.equal(blockedCatalog.capabilities.find(candidate => candidate.ref.name === 'held-personal-fork')?.effectiveEnabled, false,
      'An explicit activation does not override a blocked policy.');
    await withCapabilityPolicyStore(store => store.upsertPolicy({ organizationId: 'held-org', resourceType: 'skill', resourceId: forkCandidate.ref.resourceId,
      targetType: 'user', targetId: 'alice', effect: 'optional', actorUserId: 'owner', expectedRevision: blocked.revision }));
    const enabledForkCatalog = await catalog.resolveEffectiveCapabilitySnapshot({ ...alice, organizationId: 'held-org', role: 'member' });
    const enabledFork = enabledForkCatalog.capabilities.find(candidate => candidate.ref.name === 'held-personal-fork')!;
    assert.equal(enabledFork.effectiveEnabled, true, 'An explicit existing skill preference activates the disabled fork.');
    const ownStandalone = await skillLoader.loadSkillsFromDisk(['held-personal-fork'], { userId: 'alice' });
    assert.equal(ownStandalone.find(skill => skill.name === 'held-personal-fork')?.path, enabledFork.runtimePath,
      'The standalone loader reads exactly the committed registered pointer outside the legacy skill directory.');
    await assert.rejects(resources.inspectCapabilityResource(owner, forked.state.resourceRef), { code: 'CAPABILITY_RESOURCE_NOT_FOUND' },
      'Organization ownership does not grant read access to a personal published variant.');

    const { executeAgentBashCommand } = await import('../app/lib/pi/agent-bash-runtime');
    const { ensureAgentRuntimeTempDir } = await import('../app/lib/pi/agent-runtime-temp');
    await fs.mkdir(held.workspaceRoot, { recursive: true });
    const temp = await ensureAgentRuntimeTempDir(held);
    const oldSandbox = process.env.CANVAS_AGENT_BASH_SANDBOX;
    process.env.CANVAS_AGENT_BASH_SANDBOX = 'local-development';
    const bashInput = { command: 'true', cwd: temp, workspaceDir: held.workspaceRoot, tempDir: temp, env: { NODE_ENV: 'test' as const }, executionContext: held };
    await executeAgentBashCommand(bashInput);
    assert.equal(launches.length, 1);
    const currentScript = path.join(path.dirname(next.skillPackageBindings!.find(binding => binding.skillName === 'held-first')!.runtimePath), 'scripts/main.js');
    const currentScriptBytes = await fs.readFile(currentScript);
    await fs.chmod(currentScript, 0o600); await fs.writeFile(currentScript, 'broken-current-head\n');
    assert(!(await fresh.resolveFreshAgentSkillReadRoots(held)).includes(heldRoot),
      'An unavailable current resource denies every held version until the current publication is repaired.');
    await assert.rejects(executeAgentBashCommand(bashInput), /Skill access is unavailable/);
    assert.equal(launches.length, 1);
    assert.match(await fs.readFile(script, 'utf8'), /version-one/u, 'Fail-closed current status never overwrites intact old version bytes.');
    await fs.writeFile(currentScript, currentScriptBytes); await fs.chmod(currentScript, 0o400);
    assert((await fresh.resolveFreshAgentSkillReadRoots(held)).includes(heldRoot));
    const originalScript = await fs.readFile(script);
    await fs.chmod(script, 0o600); await fs.writeFile(script, 'tampered published script\n');
    assert(!(await fresh.resolveFreshAgentSkillReadRoots(held)).includes(heldRoot), 'The real v1 byte checksum is verified after capture.');
    await assert.rejects(execution.runWithAgentExecutionContext(held, () => fileAccess.assertAgentPathAllowed(script)), /unavailable|limited|restricted|denied/i);
    await assert.rejects(executeAgentBashCommand(bashInput), /Skill access is unavailable/);
    assert.equal(launches.length, 1, 'Tampered published bytes cause zero subsequent process launches.');
    await fs.writeFile(script, originalScript); await fs.chmod(script, 0o400);
    const revoked = await resourceStore.mutateCapabilityResource(owner, ref, { expectedMetadataRevision: adopted.metadata.metadataRevision,
      expectedGrantsRevision: adopted.metadata.grantsRevision, grants: [] });
    assert.equal(revoked.metadata.grantsRevision, adopted.metadata.grantsRevision + 1);
    assert(!(await fresh.resolveFreshAgentSkillReadRoots(held)).includes(heldRoot));
    await assert.rejects(executeAgentBashCommand(bashInput), /Skill access is unavailable/);
    assert.equal(launches.length, 1, 'A live ACL revocation blocks the issued old version before Bash starts.');
    const deniedRead = await explicitRead.execute('held-revoked-read', {path: heldFirst.runtimePath});
    assert.equal(typeof (deniedRead.details as {error?: unknown}).error, 'string');
    assert(!JSON.stringify(deniedRead.content).includes('Body version-one held-first.'), 'A descriptive held prompt never bypasses current native read authorization.');
    if (oldSandbox === undefined) delete process.env.CANVAS_AGENT_BASH_SANDBOX; else process.env.CANVAS_AGENT_BASH_SANDBOX = oldSandbox;
    const outsider = await catalog.resolveEffectiveCapabilitySnapshot({ userId: 'outsider', organizationId: 'held-org', role: 'member', workspaceId: 'held-team' });
    assert(!outsider.capabilities.some(candidate => candidate.ref.name === 'held-first' && candidate.effectiveEnabled));
    console.log('capability-package-runtime-test: PASS (actual installed/SQL authority, held v1 after v2, exact child reissue, prompt/root parity, full byte tamper and live ACL revocation before launch)');
  } finally {
    loader._load = original;
    await raw.close(); await database.close();
    async function unlock(directory: string): Promise<void> {
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        await fs.chmod(directory, 0o700);
        for (const entry of await fs.readdir(directory)) await unlock(path.join(directory, entry));
      }
    }
    await unlock(root); await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
