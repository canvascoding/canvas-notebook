import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Genuine SQL pending configuration, SourceUse locks, published sources and later real Runtime parity. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  try {
    const { alice, owner, organizationId, sql } = fixture;
    const actor = { ...alice, source: 'api' as const };
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const registry = await import('../app/lib/agents/registry');
    const workflows = await import('../app/lib/agents/workflow-configuration');
    const management = await import('../app/lib/agents/management-actions');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const sources = await import('../app/lib/agents/extension-context-package-metadata');
    const catalog = await import('../app/lib/capabilities/catalog');
    const { CapabilityPolicyStore } = await import('../app/lib/capabilities/policy-store');
    const policies = new CapabilityPolicyStore(sql);
    const prefix = `package-preflight-${randomUUID().slice(0, 8)}`;
    const grants = [owner.userId, alice.userId].map(targetId => ({ targetType: 'user' as const, targetId,
      canUse: true, canEdit: false, canManage: false }));
    const skill = (name: string) => `---\nname: ${name}\ndescription: Actual ${name} instructions\nmetadata:\n  version: "1.0.0"\n---\n\nFollow this exact published source.\n`;
    const declaration = (id: string) => ({ version: 1, integrationCapabilities: [{ id, application: 'canva', required: false,
      alternatives: [{ source: 'composio', toolkit: 'canva' }] }] });
    async function install(kind: 'plugin' | 'skill', name: string, files: Record<string, string>) {
      const archive = await fixture.registry.addPackage('application', kind, name, '1.0.0', files, plugins.computeCanvasPluginChecksum);
      return stores.installCapabilityPackageFromStoreAction(owner, { source: { kind, registryId: 'store-application', entryKey: name,
        version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' }, grants });
    }
    const root = await install('plugin', `${prefix}-root`, { '.canvas-plugin/plugin.json': JSON.stringify({ name: `${prefix}-root`,
      version: '1.0.0', description: 'Exact root package', skills: '.', workflow: declaration('parent') }),
    'SKILL.md': skill('preflight-root-step'), 'agents/canvas.yaml': `workflow: ${JSON.stringify(declaration('root'))}\n` });
    const nested = await install('plugin', `${prefix}-nested`, { '.canvas-plugin/plugin.json': JSON.stringify({ name: `${prefix}-nested`,
      version: '1.0.0', description: 'Exact nested package', skills: './skills', workflow: declaration('nested-parent') }),
    'skills/preflight-required-child/SKILL.md': skill('preflight-required-child'),
    'skills/preflight-required-child/agents/canvas.yaml': `workflow: ${JSON.stringify(declaration('required-child'))}\n`,
    'skills/preflight-optional-child/SKILL.md': skill('preflight-optional-child') });
    const required = await install('skill', `${prefix}-required`, { 'SKILL.md': skill(`${prefix}-required`) });
    const lateRequired = await install('skill', `${prefix}-late-required`, { 'SKILL.md': skill(`${prefix}-late-required`) });
    const policyContext = { userId: alice.userId, organizationId, workspaceId: alice.workspaceId, role: 'member' };
    const candidates = await catalog.loadCapabilityCandidates(policyContext, { resolveConnections: false });
    const child = candidates.find(value => value.ref.sourcePluginId === nested.resource.legacyResourceId && value.ref.name === 'preflight-required-child'); assert(child);
    for (const resourceId of [required.resource.legacyResourceId, child.ref.resourceId]) await policies.upsertPolicy({ organizationId,
      resourceType: 'skill', resourceId, effect: 'required', targetType: 'user', targetId: alice.userId, actorUserId: owner.userId });
    const pin = (value: typeof root) => ({ resourceRef: value.resource.resourceRef, publishedRevisionRef: value.published.revisionRef, checksum: value.published.checksum });
    const configuration: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed', standalone: [],
      selections: [{ selection: { kind: 'plugin', package: pin(root), skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null },
        { selection: { kind: 'plugin', package: pin(nested), skillSelection: { kind: 'subset', relativeRoots: [] } }, requirement: 'optional', toolCap: null }],
      workflow: { version: 1, packages: [root, nested].map(value => ({ ...pin(value), skillSelection: { kind: 'plugin' }, declarations: [] })) } };
    const created = await management.createManagedAgent(actor, { name: `${prefix} Actual Agent`, enabledTools: ['read'], extensions: configuration });
    const initial = await workflows.readManagedAgentWorkflow(actor, created.agent.agentId);
    const prepared = await sources.prepareAgentExtensionContextPackageSources(actor, initial);
    assert.equal(prepared.length, 2, 'Additional required standalone sources are guards, never invented configured packages.');
    assert.deepEqual(prepared.map(value => value.storage.resourceId), [...prepared.map(value => value.storage.resourceId)].sort((left, right) => left.localeCompare(right)));
    const unguarded = await fixture.database.openDb();
    try {
      await unguarded.run('BEGIN');
      await assert.rejects(sources.buildAgentExtensionPackageContextOnConnection({ database: unguarded, actor, snapshot: initial }),
        { code: 'AGENT_EXTENSION_CONTEXT_SOURCE_CHANGED' }, 'The assembler cannot acquire package locks without its private callback guard.');
    } finally { await unguarded.run('ROLLBACK'); await unguarded.close(); }
    const database = await fixture.database.openDb();
    let pending: Awaited<ReturnType<typeof sources.buildAgentExtensionPackageContextOnConnection>> | undefined;
    try {
      await database.run('BEGIN');
      await sources.withAgentExtensionContextPackageSources(database, actor, prepared, async () => {
        const next = await registry.updateAgentProfile({ agentId: initial.agent.agentId, expectedRevision: initial.agent.revision,
          name: `${prefix} Pending SQL name` }, database);
        const actual = await workflows.readManagedAgentWorkflowOnConnection(database, next.agentId);
        assert.equal(actual.agent.name, `${prefix} Pending SQL name`);
        pending = await sources.buildAgentExtensionPackageContextOnConnection({ database, actor, snapshot: actual });
        await assert.rejects(sources.buildAgentExtensionPackageContextOnConnection({ database, actor, snapshot: initial }), { code: 'AGENT_EXTENSION_CONTEXT_SOURCE_CHANGED' });
        assert(pending.skills.some(value => value.core));
        assert(pending.skills.some(value => value.name === `${prefix}-required` && value.required && value.package?.kind === 'skill'));
        const normalized = pending.configurations.find(value => value.resourceRef === nested.resource.resourceRef)!;
        assert.deepEqual(normalized.selectedSkills.map(value => value.relativeRoot), ['skills/preflight-required-child']);
        assert.equal(pending.packages.find(value => value.resourceRef === root.resource.resourceRef)!.skills[0].package?.relativeRoot, '');
      });
    } finally { await database.run('ROLLBACK'); await database.close(); }
    assert(pending); assert.equal((await registry.getAgentProfile(initial.agent.agentId))?.name, initial.agent.name);
    const { piSessions } = await import('../app/lib/db/schema');
    const sessionId = `preflight-${randomUUID()}`;
    await fixture.database.db.insert(piSessions).values({ sessionId, userId: alice.userId, agentId: initial.agent.agentId,
      workspaceId: alice.workspaceId, workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const context = await sessions.resolveAgentExecutionContextForSession({ userId: alice.userId, sessionId, agentId: initial.agent.agentId });
    const actualSelection = await runtime.getAuthorizedAgentWorkflowPackageSelections(context);
    assert.deepEqual(pending.packages, runtime.getAuthorizedAgentWorkflowPackageMetadata(actualSelection, context));
    assert.deepEqual(pending.skills, await runtime.getAuthorizedAgentWorkflowSkillMetadata(actualSelection, context));
    assert.deepEqual(pending.configurations, actualSelection.packages);
    assert.equal(runtime.isAuthorizedAgentWorkflowPackageSelections(pending, context), false);

    const raceBase = await fixture.database.openDb();
    let lateSourceLocks = 0;
    const raceDatabase: typeof raceBase = { ...raceBase, get: async (query, params) => {
      if (query.includes('pg_advisory_xact_lock') && params?.[0] === `capability-resource:${lateRequired.resource.legacyResourceId}`) lateSourceLocks += 1;
      return raceBase.get(query, params);
    } };
    const policyConnection = fixture.native ? await fixture.openObserverConnection() : raceDatabase;
    let flippedPolicyId: string | undefined;
    try {
      await raceDatabase.run('BEGIN');
      await sources.withAgentExtensionContextPackageSources(raceDatabase, actor, prepared, async () => {
        const next = await registry.updateAgentProfile({ agentId: initial.agent.agentId, expectedRevision: initial.agent.revision,
          name: `${prefix} Must roll back after late policy` }, raceDatabase);
        // The package already exists and is committed. Change the actual policy
        // only after sorted source guards and the actual Agent row are held.
        // Native PostgreSQL commits this change on a separate genuine lease.
        const flipped = await new CapabilityPolicyStore(policyConnection).upsertPolicy({ organizationId,
          resourceType: 'skill', resourceId: lateRequired.resource.legacyResourceId, effect: 'required',
          targetType: 'user', targetId: alice.userId, actorUserId: owner.userId });
        flippedPolicyId = flipped.id;
        const actual = await workflows.readManagedAgentWorkflowOnConnection(raceDatabase, next.agentId);
        await assert.rejects(sources.buildAgentExtensionPackageContextOnConnection({ database: raceDatabase, actor, snapshot: actual }),
          { code: 'AGENT_EXTENSION_CONTEXT_SOURCE_CHANGED' });
        assert.equal(lateSourceLocks, 0, 'A newly required source must be rejected before its first resource advisory lock.');
      });
    } finally {
      await raceDatabase.run('ROLLBACK'); await raceDatabase.close();
      if (fixture.native) { await policyConnection.run('DELETE FROM capability_policies WHERE id=$1', [flippedPolicyId]); await policyConnection.close(); }
    }
    assert.equal((await registry.getAgentProfile(initial.agent.agentId))?.name, initial.agent.name);

    const changedTransaction = await fixture.database.openDb();
    try {
      await changedTransaction.run('BEGIN');
      await sources.withAgentExtensionContextPackageSources(changedTransaction, actor, prepared, async () => {
        await changedTransaction.run('COMMIT'); await changedTransaction.run('BEGIN');
        await assert.rejects(sources.buildAgentExtensionPackageContextOnConnection({ database: changedTransaction, actor, snapshot: initial }),
          { code: 'AGENT_EXTENSION_CONTEXT_SOURCE_CHANGED' }, 'A reused connection cannot reuse source locks from its previous actual transaction.');
      });
    } finally { await changedTransaction.run('ROLLBACK'); await changedTransaction.close(); }

    await sql.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2', [root.resource.resourceRef, alice.userId]);
    const rejected = await fixture.database.openDb(); let entered = false;
    try {
      await rejected.run('BEGIN');
      await assert.rejects(sources.withAgentExtensionContextPackageSources(rejected, actor, prepared, async () => { entered = true; }));
      assert.equal(entered, false, 'A stale prepared source cannot enter the Agent mutation after actual SourceUse revocation.');
    } finally { await rejected.run('ROLLBACK'); await rejected.close(); }
    assert.equal((await registry.getAgentProfile(initial.agent.agentId))?.revision, initial.agent.revision);
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} pending Agent package context: real SQL update+rollback, same-lease source/pin authority, exact runtime Package/Skill/config parity, required children and standalone/Core paths, root SKILL, private source callback/actual transaction guard, late required-policy rejection before a new resource lock, stale revision and actual Use revocation, no runtime issuer or provider probes.`);
  } finally { await fixture.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
