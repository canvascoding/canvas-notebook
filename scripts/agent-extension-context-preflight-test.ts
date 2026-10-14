import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { Pool } from 'pg';
import type { AgentExtensionConfigurationInput, ExtensionPackagePin } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

type FixedAgentExtensions = Extract<AgentExtensionConfigurationInput, { mode: 'fixed' }>;

async function directoryBytes(directory: string): Promise<Record<string, string> | null> {
  try {
    const result: Record<string, string> = {};
    const visit = async (current: string) => {
      for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
        const full = path.join(current, entry.name);
        assert.equal(entry.isSymbolicLink(), false, 'The owned Agent fixture has no symlink storage.');
        if (entry.isDirectory()) await visit(full);
        else result[path.relative(directory, full)] = (await fs.readFile(full)).toString('base64');
      }
    };
    await visit(directory);
    return result;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// No production preflight/registry/renderer or authority method is substituted.
// Real ZIP publication, SQL writes and scoped files exercise the final writer
// gate. Only the external model catalogue has an inert fixture implementation.
async function main() {
  const maintenanceUrl = process.env.DATABASE_URL;
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const databaseName = fixture.native ? (await fixture.sql.get('SELECT current_database() AS name') as { name: string }).name : '';
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const previousLoad = loader._load;
  loader._load = (name, parent, isMain) => name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat'
    ? { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => {}, isContextOverflow: () => false }
    : previousLoad(name, parent, isMain);
  let stage = 'load services';
  try {
    const management = await import('../app/lib/agents/management-actions');
    const workflows = await import('../app/lib/agents/workflow-configuration');
    const registry = await import('../app/lib/agents/registry');
    const pluginRegistry = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const { readAgentExtensionPackageVersion } = await import('../app/lib/agents/extension-package-options');
    const paths = await import('../app/lib/runtime-data-paths');
    const storage = await import('../app/lib/agents/storage');
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { EXTENSION_CONTEXT_MAX_BYTES, EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS, renderEffectiveExtensionContext } = await import('../app/lib/capabilities/extensions/context-prompt');
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const { resolveEffectiveExtensionContext, readEffectiveExtensionContext } = await import('../app/lib/capabilities/extensions/effective-context');
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const { parseIntegrationRequest } = await import('../app/lib/integration-tools/contracts');
    await storage.writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG, activeProvider: 'google',
      runtimeMigrations: { skillToolsDefaultEnabled: true }, providers: { ...DEFAULT_PI_CONFIG.providers,
        google: { ...DEFAULT_PI_CONFIG.providers.google, model: 'fixture-metadata-only-model', enabledTools: ['read'] } } });
    const actor = { ...fixture.owner, source: 'api' as const };
    const prefix = `context-preflight-${randomUUID().slice(0, 8)}`;
    const childNames = Array.from({ length: 48 }, (_, index) => `preflight-child-${String(index + 1).padStart(2, '0')}-`.padEnd(64, 'x'));
    const grant = { targetType: 'user' as const, targetId: fixture.alice.userId, canUse: true, canEdit: false, canManage: false };
    const empty: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed',
      selections: [], workflow: null, standalone: [] };
    const pluginConfiguration = (pin: ExtensionPackagePin, count: number, names = childNames): FixedAgentExtensions => ({ ...empty,
      mode: 'fixed', selections: [{ selection: { kind: 'plugin', package: pin,
        skillSelection: count === names.length ? { kind: 'all' } : { kind: 'subset', relativeRoots: names.slice(0, count).map(name => `skills/${name}`) } },
      requirement: 'required', toolCap: null }],
      workflow: { version: 1, packages: [{ ...pin, skillSelection: { kind: 'plugin' }, declarations: [] }] } });
    const sqlSnapshot = async (agentId: string) => ({
      agent: await fixture.sql.get('SELECT * FROM agents WHERE agent_id=$1', [agentId]),
      bindings: await fixture.sql.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY id', [agentId]),
      grants: await fixture.sql.all('SELECT * FROM agent_grants WHERE agent_id=$1 ORDER BY id', [agentId]),
      members: await fixture.sql.all('SELECT * FROM agent_members WHERE agent_id=$1 ORDER BY user_id', [agentId]),
      preferences: await fixture.sql.all('SELECT * FROM agent_user_preferences WHERE agent_id=$1 ORDER BY user_id', [agentId]),
    });
    const filesSnapshot = async (agentId: string) => ({
      definition: await directoryBytes(path.join(paths.resolveOrganizationAgentsDir(fixture.organizationId), agentId)),
      personal: await directoryBytes(path.join(paths.resolveUserAgentsDir(actor.userId), agentId)),
    });
    const absent = async (agentId: string) => {
      assert.equal(await registry.getAgentProfile(agentId), null);
      const snapshot = await sqlSnapshot(agentId);
      assert.equal(snapshot.agent, undefined);
      for (const rows of [snapshot.bindings, snapshot.grants, snapshot.members, snapshot.preferences]) assert.deepEqual(rows, []);
      assert.deepEqual(await filesSnapshot(agentId), { definition: null, personal: null });
    };
    const budgetError = (error: unknown) => {
      assert(error && typeof error === 'object');
      assert.equal(Reflect.get(error, 'code'), 'AGENT_EXTENSION_CONTEXT_TOO_LARGE');
      assert.equal(Reflect.get(error, 'status'), 409);
      assert(Number(Reflect.get(error, 'requiredBytes')) > EXTENSION_CONTEXT_MAX_BYTES,
        'The actual renderer must prove its mandatory UTF-8 context exceeds the shared budget.');
      return true;
    };
    const assertActualRuntimeBudget = async (agentId: string, selectedChildCount: number, hasProvider: boolean) => {
      // An actual stored session is arranged, then all current actor/Agent/
      // workspace/package authority is issued by the production resolvers.
      const sessionId = `${agentId}-${randomUUID().slice(0, 8)}`;
      await fixture.sql.run(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,created_at,updated_at,
        organization_id,workspace_id,workspace_type) VALUES($1,$2,$3,'fixture','fixture',1,1,$4,$5,'personal')`,
      [sessionId, actor.userId, agentId, fixture.organizationId, actor.workspaceId]);
      const base = await resolveAgentExecutionContextForStoredSession({ userId: actor.userId, agentId, sessionId });
      const current = await resolveEffectiveExtensionContext(base);
      const data = readEffectiveExtensionContext(current);
      assert(data);
      assert.equal(data.mode, 'fixed');
      assert.equal(data.packages.length, 1);
      assert.equal(data.packages[0].skills.length, selectedChildCount);
      assert.equal(data.workflowProjection?.selectedProviders.length, hasProvider ? 1 : 0);
      const tools = await getPiTools(actor.userId, agentId, sessionId, { executionContext: current,
        strictAuthorization: true, metadataOnlyExternal: true });
      for (const query of ['😀'.repeat(EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS), '\ud800'.repeat(EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS)]) {
        const rendered = renderEffectiveExtensionContext(data, tools, query);
        assert(rendered.budget.usedBytes <= EXTENSION_CONTEXT_MAX_BYTES);
        assert.equal(Buffer.byteLength(rendered.prompt), rendered.budget.usedBytes);
        if (hasProvider) {
          const recipes = rendered.prompt.split('\n').filter(line => /^C\d+ exact tool search template:/u.test(line));
          assert.equal(recipes.length, 1, 'The genuine selected provider retains its exact tool-search route under the UTF-8 budget.');
          const recipe = recipes[0]!, start = recipe.indexOf('{');
          assert(start >= 0);
          const request = parseIntegrationRequest(JSON.parse(recipe.slice(start, recipe.indexOf('}', start) + 1)));
          assert(request.action === 'search' && request.target === 'tools');
          assert.equal(request.providerRef, data.workflowProjection!.selectedProviders[0]!.providerRef);
          assert.equal(request.query, '<short tool name>');
          assert(!recipe.includes(JSON.stringify(query)), 'The tool-search template never copies the original task payload into its query.');
          const substituted = parseIntegrationRequest({ ...request, query: 'echo' });
          assert(substituted.action === 'search' && substituted.target === 'tools');
          assert.equal(substituted.providerRef, request.providerRef); assert.equal(substituted.query, 'echo',
            'Replacing the placeholder with a short tool name produces a valid actual integration request without changing the provider.');
        }
      }
    };

    stage = 'publish the actual 48-child plugin';
    const files: Record<string, string> = { '.canvas-plugin/plugin.json': JSON.stringify({ name: prefix, version: '1.0.0',
      description: 'Real published context-budget fixture', skills: './skills' }) };
    for (const name of childNames) files[`skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: Compact published child instructions.\n---\n\n# ${name}\n\nUse only the selected source.\n`;
    const archive = await fixture.registry.addPackage('application', 'plugin', prefix, '1.0.0', files, pluginRegistry.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(fixture.owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: prefix, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: actor.userId, canUse: true, canEdit: false, canManage: false }] });
    const pin: ExtensionPackagePin = { resourceRef: installed.resource.resourceRef,
      publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const held = await readAgentExtensionPackageVersion(fixture.owner, pin, { allowPersonalPackages: false });
    assert.equal(held.metadata.skillRoots.length, 48);
    assert.deepEqual(held.metadata.skillRoots.map(skill => skill.name).sort(), [...childNames].sort());

    stage = 'Create rejects the actual oversized mandatory index atomically';
    const failedId = `${prefix}-large`;
    const stagedTables = new Set<string>();
    fixture.setAfterQuery(async (query, parameters) => {
      const table = /INSERT INTO\s+(agents|agent_members|agent_capability_bindings|agent_grants)\s*\(/u.exec(query)?.[1];
      if (table && parameters.includes(failedId)) stagedTables.add(table);
    });
    await assert.rejects(management.createManagedAgent(actor, { name: 'Oversized published plugin', agentId: failedId,
      scopeType: 'organization', enabledTools: ['read'], extensions: pluginConfiguration(pin, 48), grants: [grant],
      files: { 'AGENTS.md': 'A rejected configuration cannot leave this definition.', 'MEMORY.md': 'No rejected memory remains.' } }), budgetError);
    fixture.setAfterQuery(undefined);
    assert(stagedTables.has('agents') && stagedTables.has('agent_capability_bindings'),
      'The real pending profile/binding writes reached the final gate, rather than a schema-only rejection.');
    await absent(failedId);

    stage = 'small plugin configuration fits and commits';
    const small = await management.createManagedAgent(actor, { name: 'Small exact subset', agentId: `${prefix}-small`,
      scopeType: 'organization', enabledTools: ['read'], extensions: pluginConfiguration(pin, 1), grants: [grant],
      files: { 'AGENTS.md': 'Stable original definition.', 'MEMORY.md': 'Stable original personal memory.' } });
    assert.equal(small.agent.workflowVersion, 2);
    const beforeSql = await sqlSnapshot(small.agent.agentId);
    const beforeFiles = await filesSnapshot(small.agent.agentId);
    assert(beforeFiles.definition && beforeFiles.personal);
    assert(beforeSql.bindings.length > 0 && beforeSql.members.length > 0 && beforeSql.grants.length > 0);

    stage = 'Update small to large rolls back profile/revisions/bindings/files exactly';
    await assert.rejects(workflows.updateManagedAgentConfiguration({ actor, agentId: small.agent.agentId,
      expectedRevision: small.agent.revision, expectedWorkflowRevision: small.agent.workflowRevision ?? 0,
      name: 'This name must roll back', extensions: pluginConfiguration(pin, 48) }), budgetError);
    assert.deepEqual(await sqlSnapshot(small.agent.agentId), beforeSql);
    assert.deepEqual(await filesSnapshot(small.agent.agentId), beforeFiles);

    stage = 'publish a real standalone skill and reject disabled reading';
    const skillName = `${prefix}-skill`;
    const skillArchive = await fixture.registry.addPackage('application', 'skill', skillName, '1.0.0', {
      'SKILL.md': `---\nname: ${skillName}\ndescription: A real published standalone skill.\nmetadata:\n  version: 1.0.0\n---\n\n# Standalone instructions\n`,
    }, pluginRegistry.computeCanvasPluginChecksum);
    const installedSkill = await stores.installCapabilityPackageFromStoreAction(fixture.owner, { source: { kind: 'skill', registryId: 'store-application',
      entryKey: skillName, version: '1.0.0', checksum: skillArchive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: actor.userId, canUse: true, canEdit: false, canManage: false }] });
    const skillPin: ExtensionPackagePin = { resourceRef: installedSkill.resource.resourceRef,
      publishedRevisionRef: installedSkill.published.revisionRef, checksum: installedSkill.published.checksum };
    const skillConfiguration: AgentExtensionConfigurationInput = { ...empty, mode: 'fixed',
      selections: [{ selection: { kind: 'skill', package: skillPin, origin: 'standalone', relativeRoot: '' }, requirement: 'required', toolCap: null }],
      workflow: { version: 1, packages: [{ ...skillPin, skillSelection: { kind: 'skills', relativeRoots: [''] }, declarations: [] }] } };
    const noReadId = `${prefix}-no-read`;
    await assert.rejects(management.createManagedAgent(actor, { name: 'Disabled skill reading', agentId: noReadId,
      scopeType: 'organization', enabledTools: ['__none__'], extensions: skillConfiguration, grants: [grant],
      files: { 'AGENTS.md': 'No partially saved disabled configuration.' } }), { code: 'AGENT_EXTENSION_READ_TOOL_REQUIRED', status: 409 });
    await absent(noReadId);
    await assert.rejects(workflows.updateManagedAgentConfiguration({ actor, agentId: small.agent.agentId,
      expectedRevision: small.agent.revision, expectedWorkflowRevision: small.agent.workflowRevision ?? 0,
      name: 'Disabled update must roll back', enabledTools: ['__none__'], extensions: skillConfiguration }),
    { code: 'AGENT_EXTENSION_READ_TOOL_REQUIRED', status: 409 });
    assert.deepEqual(await sqlSnapshot(small.agent.agentId), beforeSql);
    assert.deepEqual(await filesSnapshot(small.agent.agentId), beforeFiles);

    stage = 'real shared connection metadata for both personal choice gates';
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const { setManagedAgentStandaloneChoice } = await import('../app/lib/agents/extension-choice');
    const { agentWorkflowCapabilityKey } = await import('../app/lib/agents/workflow-contracts');
    const source = await createSharedMcpConnection({ ...fixture.owner, organizationId: fixture.organizationId }, {
      ownership: { type: 'organization', organizationId: fixture.organizationId },
      displayName: 'Actual permitted shared connection '.padEnd(128, 'm'), accessMode: 'restricted',
      allowedToolNames: ['read_fixture'],
      grants: [{ targetType: 'user', targetId: actor.userId, canUse: true, canManage: true, allowedToolNames: ['read_fixture'] }],
      config: { url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true },
    });
    const sourceSelection = { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'shared' as const,
      connectionRef: source.resource.connectionRef, bindingRevision: source.resource.bindingRevision } };
    const standaloneConfiguration = (count: number): FixedAgentExtensions => ({ ...pluginConfiguration(pin, count), mode: 'fixed',
      standalone: [{ mode: 'selectable', configurationId: 'budget-required-reader', source: 'mcp', requirement: 'required',
        allowedChoices: [{ choiceId: 'shared-reader', selection: sourceSelection, toolCap: ['read_fixture'] }] }] });

    // Find the true mandatory-index boundary through actual atomic writes.
    // No renderer is replaced and no guessed child count is treated as proof.
    const exerciseChoiceBoundary = async (kind: 'package' | 'standalone', configure: (count: number) => AgentExtensionConfigurationInput,
      packagePin: ExtensionPackagePin) => {
      stage = `${kind} choice: positive actual gate and explicit clear`;
      const created = await management.createManagedAgent(actor, { agentId: `${prefix}-${kind}-choice`, name: `${kind} choice budget`,
        scopeType: 'organization', enabledTools: ['read', 'mcp'], extensions: configure(1),
        files: { 'AGENTS.md': 'Choice budget checks keep this source byte-identical.' } });
      let latest = created.agent;
      const snapshot = await workflows.readManagedAgentWorkflow(actor, latest.agentId);
      const standalone = snapshot.bindings.find(binding => binding.standaloneConfiguration?.mode === 'selectable');
      const key = kind === 'standalone' ? standalone?.resourceId
        : agentWorkflowCapabilityKey(packagePin.resourceRef, '.canvas-plugin/plugin.json', 'budget-reader');
      assert(key);
      await fixture.sql.run(`INSERT INTO agent_user_preferences(agent_id,user_id,preferences_json,revision,created_at,updated_at)
        VALUES($1,$2,$3,7,1,1)`, [latest.agentId, actor.userId, JSON.stringify({ unrelatedFixtureSetting: 'must survive', workflowChoices: {} })]);
      const choose = (choiceId: string | null, preferenceRevision: number) => {
        const input = { actor, agentId: latest.agentId, capabilityKey: key, expectedWorkflowRevision: latest.workflowRevision ?? 0,
          expectedPreferenceRevision: preferenceRevision, choiceId };
        return kind === 'standalone' ? setManagedAgentStandaloneChoice(input) : workflows.setManagedAgentWorkflowChoice(input);
      };
      await choose('shared-reader', 7);
      const selectedPreference = await fixture.sql.get('SELECT preferences_json,revision FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2',
        [latest.agentId, actor.userId]) as { preferences_json: string; revision: number };
      assert.equal(Number(selectedPreference.revision), 8);
      assert.equal(JSON.parse(selectedPreference.preferences_json).unrelatedFixtureSetting, 'must survive');
      assert.equal(JSON.parse(selectedPreference.preferences_json).workflowChoices[key].choiceId, 'shared-reader');
      await assertActualRuntimeBudget(latest.agentId, 1, true);
      await choose(null, 8);
      const missingChoice = await workflows.readManagedAgentWorkflow(actor, latest.agentId);
      assert.equal(missingChoice.preferenceRevision, 9);
      assert.equal(missingChoice.choices[key], undefined, 'An explicit clear restores the required missing selection without choosing a default.');

      stage = `${kind} choice: actual write boundary search`;
      const updateCount = (count: number) => workflows.updateManagedAgentConfiguration({ actor, agentId: latest.agentId,
        expectedRevision: latest.revision, expectedWorkflowRevision: latest.workflowRevision ?? 0, extensions: configure(count) });
      const beforeOversized = await sqlSnapshot(latest.agentId);
      await assert.rejects(updateCount(48), budgetError);
      assert.deepEqual(await sqlSnapshot(latest.agentId), beforeOversized);
      let fits = 1, exceeds = 48;
      while (exceeds - fits > 1) {
        const count = Math.floor((fits + exceeds) / 2);
        const beforeAttempt = await sqlSnapshot(latest.agentId);
        try {
          const updated = await updateCount(count);
          latest = updated.agent;
          fits = count;
        } catch (error) {
          budgetError(error);
          assert.deepEqual(await sqlSnapshot(latest.agentId), beforeAttempt);
          exceeds = count;
        }
      }
      const beforeChoiceSql = await sqlSnapshot(latest.agentId);
      const beforeChoiceFiles = await filesSnapshot(latest.agentId);
      await assertActualRuntimeBudget(latest.agentId, fits, false);
      stage = `${kind} choice: selected descriptor plus exact recipe overflows and preference CAS rolls back`;
      await assert.rejects(choose('shared-reader', 9), budgetError);
      assert.deepEqual(await sqlSnapshot(latest.agentId), beforeChoiceSql,
        'The actual choice write and its revision increment must roll back with the rest of the exact SQL state.');
      assert.deepEqual(await filesSnapshot(latest.agentId), beforeChoiceFiles);
      const remaining = await workflows.readManagedAgentWorkflow(actor, latest.agentId);
      assert.equal(remaining.preferenceRevision, 9);
      assert.equal(remaining.choices[key], undefined);
      console.log(`Actual ${kind} choice boundary: ${fits} published children fit with required missing choice; ${exceeds} fail; selecting the allowed shared descriptor fails atomically.`);
    };
    await exerciseChoiceBoundary('standalone', standaloneConfiguration, pin);

    stage = 'publish a real plugin requirement for the package choice gate';
    const choiceName = `${prefix}-declared`;
    const choiceChildNames = Array.from({ length: 48 }, (_, index) => `preflight-declared-child-${String(index + 1).padStart(2, '0')}-`.padEnd(64, 'x'));
    const choiceFiles: Record<string, string> = { '.canvas-plugin/plugin.json': JSON.stringify({ name: choiceName, version: '1.0.0',
      description: 'Actual required declaration with a permitted per-user choice', skills: './skills',
      connectors: { mcp: [{ name: 'budget-service', required: false, configPath: 'mcp.json' }] },
      workflow: { version: 1, integrationCapabilities: [{ id: 'budget-reader', application: 'reader', required: true,
        alternatives: [{ source: 'mcp', connector: 'budget-service', requiredTools: ['read_fixture'] }] }] } }),
    'mcp.json': JSON.stringify({ url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none' }) };
    for (const name of choiceChildNames) choiceFiles[`skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: Published declaration child instructions.\n---\n\n# ${name}\n`;
    const choiceArchive = await fixture.registry.addPackage('application', 'plugin', choiceName, '1.0.0', choiceFiles, pluginRegistry.computeCanvasPluginChecksum);
    const choiceInstalled = await stores.installCapabilityPackageFromStoreAction(fixture.owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: choiceName, version: '1.0.0', checksum: choiceArchive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: actor.userId, canUse: true, canEdit: false, canManage: false }] });
    const choicePin: ExtensionPackagePin = { resourceRef: choiceInstalled.resource.resourceRef,
      publishedRevisionRef: choiceInstalled.published.revisionRef, checksum: choiceInstalled.published.checksum };
    const packageChoiceConfiguration = (count: number): FixedAgentExtensions => ({ ...pluginConfiguration(choicePin, count, choiceChildNames), mode: 'fixed',
      workflow: { version: 1, packages: [{ ...choicePin, skillSelection: { kind: 'plugin' }, declarations: [{
        declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityId: 'budget-reader', selection: { mode: 'selectable',
          allowedChoices: [{ choiceId: 'shared-reader', alternativeKey: 'mcp:budget-service', target: { kind: 'shared', source: 'mcp',
            connectionRef: source.resource.connectionRef, bindingRevision: source.resource.bindingRevision,
            mcpMapping: { kind: 'manager_confirmation' } }, toolCap: ['read_fixture'] }] } }] }] }] } });
    await exerciseChoiceBoundary('package', packageChoiceConfiguration, choicePin);
    assert.equal(fixture.providerRequests(), 0, 'No provider/account/model/network probes occur; only the owned Store ZIP/registry transport is used.');
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} actual extension context preflight: 48 published children overflow 8 KiB, small subset commits, Create/Update SQL+scoped-file rollback exact, __none__ requires read, both choice gates positive and budget rollback preserve preferences; no preflight/registry/renderer mocks or provider probes.`);
  } catch (error) {
    console.error(`Extension context preflight fixture stage: ${stage}`);
    throw error;
  } finally {
    fixture.setAfterQuery(undefined);
    loader._load = previousLoad;
    await fixture.close();
    await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
    if (fixture.native) {
      const observer = new Pool({ connectionString: maintenanceUrl, max: 1 });
      try {
        assert.equal((await observer.query('SELECT COUNT(*)::integer AS count FROM pg_database WHERE datname=$1', [databaseName])).rows[0].count, 0);
      } finally { await observer.end(); }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
