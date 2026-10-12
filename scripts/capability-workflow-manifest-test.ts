import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import JSZip from 'jszip';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { parseWorkflowManifest, evaluateWorkflowRequirementGroups, validateWorkflowReferences,
  CAPABILITY_WORKFLOW_LIMITS, isWorkflowManifestError } from '../app/lib/capabilities/workflow-contracts';

const group = (id = 'designs') => ({ id, application: 'canva', alternatives: [
  { source: 'mcp', connector: 'canva-mcp', requiredTools: ['create_design'] },
  { source: 'composio', toolkit: 'canva', requiredTools: ['CANVA_CREATE_DESIGN'] },
], skillRefs: ['design-workflow'] });
const workflow = () => ({ version: 1, integrationCapabilities: [group()] });
const clone = <T>(value: T): T => structuredClone(value);

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workflow-contract-'));
  const keys = ['DATA', 'CANVAS_DATA_ROOT', 'CANVAS_ORGANIZATION_ID', 'CANVAS_DEPLOYMENT_MODE', 'CANVAS_TEAM_FEATURES_ENABLED', 'CANVAS_PLUGIN_STORE_REGISTRY_URL', 'CANVAS_MCP_DIRECT_ENABLED', 'BASE_URL'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATA: path.join(root, 'data'), CANVAS_DATA_ROOT: path.join(root, 'data'),
    CANVAS_ORGANIZATION_ID: 'workflow-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
    CANVAS_MCP_DIRECT_ENABLED: 'false', BASE_URL: 'http://localhost:3000' });
  await fs.mkdir(path.join(root, 'data'), { recursive: true, mode: 0o700 });
  const database = await createPiTestDatabase();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (name === '@earendil-works/pi-agent-core' || name === '@earendil-works/pi-ai/oauth') return {};
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    return original(name, parent, isMain);
  };
  const write = async (directory: string, relative: string, value: string | Buffer) => {
    const target = path.join(directory, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, value);
  };
  const skill = async (directory: string, name: string, value?: unknown) => {
    await write(directory, 'SKILL.md', `---\nname: ${name}\ndescription: Portable workflow fixture.\nmetadata:\n  version: "1.0.0"\n---\n\n# Workflow\n`);
    await write(directory, 'scripts/task.js', 'console.log("fixture");\n');
    if (value !== undefined) await write(directory, 'agents/canvas.yaml', YAML.stringify({ interface: { display_name: 'Portable workflow' }, workflow: value }));
  };
  try {
    const parsed = parseWorkflowManifest(workflow());
    assert.equal(parsed.integrationCapabilities[0].required, true);
    assert(Object.isFrozen(parsed.integrationCapabilities[0].alternatives));
    const allGroups = parseWorkflowManifest({ version: 1, integrationCapabilities: [group(),
      { id: 'documents', application: 'github', alternatives: [{ source: 'composio', toolkit: 'github' }] },
      { id: 'optional-chat', application: 'slack', required: false, alternatives: [{ source: 'composio', toolkit: 'slack' }] }] });
    assert.equal(evaluateWorkflowRequirementGroups(allGroups, capability => capability.id === 'designs').ready, false);
    const ready = evaluateWorkflowRequirementGroups(allGroups, (capability, alternative) => capability.id === 'documents'
      || capability.id === 'designs' && alternative.source === 'composio');
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.capabilities[0].availableAlternatives, [1], 'One alternative satisfies an OR group.');
    assert.equal(ready.capabilities[2].ready, false, 'An unavailable optional group does not satisfy or block a required group.');
    const invalid = (value: unknown) => assert.throws(() => parseWorkflowManifest(value), isWorkflowManifestError);
    for (const value of [null, [], { ...workflow(), version: 2 }, { ...workflow(), dependencies: ['designs'] },
      { ...workflow(), imports: ['https://untrusted.invalid/workflow'] }, { ...workflow(), connectionRef: 'canvas-connection:private' },
      { ...workflow(), mcpConnectors: [] }, { ...workflow(), integrationCapabilities: [group(), group()] },
      { ...workflow(), integrationCapabilities: [{ ...group(), required: 'true' }] },
      { ...workflow(), integrationCapabilities: [{ ...group(), alternatives: [] }] },
      { ...workflow(), integrationCapabilities: [{ ...group(), alternatives: [group().alternatives[0], clone(group().alternatives[0])] }] },
      { ...workflow(), integrationCapabilities: [{ ...group(), skillRefs: ['design-workflow', 'design-workflow'] }] },
      { ...workflow(), integrationCapabilities: [{ ...group(), alternatives: [{ source: 'mcp', connector: 'canva-mcp', requiredTools: ['x', 'x'] }] }] },
      { ...workflow(), integrationCapabilities: [{ ...group(), application: 'Canva' }] },
      { ...workflow(), integrationCapabilities: [{ ...group(), alternatives: [{ source: 'email', mailbox: 'private' }] }] },
      { ...workflow(), integrationCapabilities: Array.from({ length: 33 }, (_, index) => ({ ...group(`id-${index}`), skillRefs: [] })) }]) invalid(value);
    for (const field of ['accountId', 'userId', 'providerRef', 'profileId', 'credentials', 'allowedToolNames']) {
      const value = { ...workflow(), integrationCapabilities: [{ ...group(), alternatives: [{ source: 'composio', toolkit: 'canva', [field]: 'SECRET_VALUE' }] }] };
      assert.throws(() => parseWorkflowManifest(value), error => isWorkflowManifestError(error) && !error.message.includes('SECRET_VALUE'));
    }
    const cyclic: Record<string, unknown> = workflow(); cyclic.cycle = cyclic; invalid(cyclic);
    invalid({ ...workflow(), blob: 'x'.repeat(CAPABILITY_WORKFLOW_LIMITS.bytes) });
    for (const descriptor of [{ name: 'canva-mcp', userId: 'foreign' }, { name: 'canva-mcp', env: ['CANVA_TOKEN=SECRET'] },
      { name: 'canva-mcp', configPath: '../outside.json' }]) {
      assert.throws(() => parseWorkflowManifest({ ...workflow(), mcpConnectors: [descriptor] }, { allowMcpConnectors: true }), isWorkflowManifestError);
    }
    validateWorkflowReferences(parsed, { mcpConnectors: [{ name: 'canva-mcp' }], skillNames: ['design-workflow'], allowMcpConnectors: false });
    assert.throws(() => validateWorkflowReferences(parsed, { mcpConnectors: [], skillNames: ['design-workflow'], allowMcpConnectors: false }), isWorkflowManifestError);

    const raw = await database.openDb();
    await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES (\'alice\',\'Alice\',\'alice@workflow.example.test\',\'member\',1,1,1)');
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('workflow-org','alice','team',1,1,1)");
    await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('workflow-org','alice','owner','active',1,1,1)");
    const { validateCanvasPluginPackage } = await import('../app/lib/plugins/canvas-plugin-manifest');
    const { validateCompleteCapabilityPackage } = await import('../app/lib/capabilities/packages/artifacts');
    const { parsePluginSkillsFromManifest, installCanvasPluginFromPath, readCanvasPluginRegistry, computeCanvasPluginChecksum } = await import('../app/lib/plugins/canvas-plugin-registry');
    const { parseSkillFile, loadCanvasSkillWorkflow, validateStandaloneSkillWorkflow } = await import('../app/lib/skills/canvas-skill-manifest');
    const pluginRoot = path.join(root, 'packages', 'workflow-plugin');
    const manifest: Record<string, unknown> = { name: 'workflow-plugin', version: '1.0.0', description: 'Portable workflow fixture.', skills: './skills',
      connectors: { mcp: [{ name: 'canva-mcp', required: false, configPath: './connectors/canva.json', env: ['CANVA_TOKEN'] }],
        mcpServers: './optional-legacy.json', composioToolkits: ['legacy-toolkit'], email: [{ kind: 'mailbox', required: true }] }, workflow: workflow() };
    await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify(manifest));
    await write(pluginRoot, 'connectors/canva.json', '{"mcpServers":{}}');
    await skill(path.join(pluginRoot, 'skills/design-workflow'), 'design-workflow', { ...workflow(), integrationCapabilities: [{ ...group(), skillRefs: ['export-workflow'] }] });
    await skill(path.join(pluginRoot, 'skills/export-workflow'), 'export-workflow');
    const complete = await validateCompleteCapabilityPackage('plugin', pluginRoot);
    assert.deepEqual(complete.workflowDeclarations?.map(declaration => declaration.declarationPath),
      ['.canvas-plugin/plugin.json', 'skills/design-workflow/agents/canvas.yaml']);
    assert.deepEqual(complete.workflowDeclarations?.map(declaration => declaration.workflow.integrationCapabilities[0].id), ['designs', 'designs']);
    const duplicateVersionJson = JSON.stringify(manifest).replace('"workflow":{"version":1,', '"workflow":{"version":1,"version":1,');
    await write(pluginRoot, '.canvas-plugin/plugin.json', duplicateVersionJson);
    assert.equal((await validateCanvasPluginPackage(pluginRoot)).valid, false, 'Duplicate JSON keys inside the new workflow cannot disappear during normalization.');
    const escapedVersionJson = JSON.stringify(manifest).replace('"workflow":{"version":1,', '"workflow":{"version":1,"v\\u0065rsion":1,');
    await write(pluginRoot, '.canvas-plugin/plugin.json', escapedVersionJson);
    assert.equal((await validateCanvasPluginPackage(pluginRoot)).valid, false);
    const withoutWorkflow = { ...manifest }; delete withoutWorkflow.workflow;
    const escapedRootJson = `${JSON.stringify(withoutWorkflow).slice(0, -1)},"workflow":${JSON.stringify(workflow())},"\\u0077orkflow":${JSON.stringify(workflow())}}`;
    await write(pluginRoot, '.canvas-plugin/plugin.json', escapedRootJson);
    assert.equal((await validateCanvasPluginPackage(pluginRoot)).valid, false, 'Escaped top-level duplicates still identify the same workflow field.');
    await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify(manifest).replace('"description":', '"unrelated":1,"unrelated":2,"description":'));
    assert.equal((await validateCanvasPluginPackage(pluginRoot)).valid, true, 'Unrelated legacy JSON keys retain their previous parsing behavior.');
    await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify(manifest));
    const installed = await installCanvasPluginFromPath(pluginRoot, { scope: { userId: 'alice' }, enable: false });
    assert.equal(installed.success, true, JSON.stringify(installed.validation?.errors));
    const legacy = clone(manifest); delete legacy.workflow;
    await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify(legacy));
    const legacyManifest = (await validateCanvasPluginPackage(pluginRoot)).manifest!;
    assert.equal(legacyManifest.workflow, undefined);
    assert.equal(legacyManifest.connectors?.mcpServers, './optional-legacy.json');
    assert.deepEqual(legacyManifest.connectors?.composioToolkits, ['legacy-toolkit']);
    assert.equal(legacyManifest.connectors?.email?.[0].required, true);
    const requiredLegacy = { ...manifest, connectors: { mcp: [{ name: 'canva-mcp', required: true }] } };
    await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify(requiredLegacy));
    assert.equal((await validateCanvasPluginPackage(pluginRoot)).manifest?.connectors?.mcp?.[0].required, true,
      'A workflow alternative does not reinterpret an existing independently required connector.');
    await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify(legacy));
    assert.equal((await validateCompleteCapabilityPackage('plugin', pluginRoot)).workflowDeclarations?.length, 1, 'A child declaration stays independent of the absent parent.');
    await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify(manifest));
    const missingSkill = { ...manifest, name: 'never-installed', workflow: { ...workflow(), integrationCapabilities: [{ ...group(), skillRefs: ['missing-skill'] }] } };
    await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify(missingSkill));
    await assert.rejects(validateCompleteCapabilityPackage('plugin', pluginRoot), /workflow.*skill reference/i);
    const refused = await installCanvasPluginFromPath(pluginRoot, { scope: { userId: 'alice' }, enable: false });
    assert.equal(refused.success, false);
    assert.match(refused.validation?.errors.join(' ') ?? '', /workflow.*skill reference/i);
    assert.equal((await readCanvasPluginRegistry({ userId: 'alice' })).plugins['never-installed'], undefined, 'An invalid workflow never creates an installed plugin.');
    for (const connectors of [{ mcp: [] }, { mcp: [{ name: 'canva-mcp' }, { name: 'canva-mcp' }] }]) {
      await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify({ ...manifest, connectors }));
      assert.equal((await validateCanvasPluginPackage(pluginRoot)).valid, false);
    }
    await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify(manifest));
    await write(path.join(pluginRoot, 'skills/design-workflow'), 'agents/canvas.yaml', YAML.stringify({ workflow: { ...workflow(), mcpConnectors: [] } }));
    await assert.rejects(validateCompleteCapabilityPackage('plugin', pluginRoot), /Only standalone/);
    await write(path.join(pluginRoot, 'skills/design-workflow'), 'agents/canvas.yaml', YAML.stringify({ workflow: workflow() }));
    const changed = await validateCompleteCapabilityPackage('plugin', pluginRoot);
    assert.notEqual(changed.checksum, complete.checksum, 'The full immutable checksum includes child workflow bytes.');
    const seedRoot = path.join(root, 'packages', 'seed-reference');
    await write(seedRoot, '.canvas-plugin/plugin.json', JSON.stringify({ name: 'seed-reference', version: '1.0.0', description: 'Explicit seed context.',
      skillRefs: [{ name: 'brand-guidelines', source: 'seed' }], workflow: { version: 1, integrationCapabilities: [{ id: 'brand', application: 'canva',
        alternatives: [{ source: 'composio', toolkit: 'canva' }], skillRefs: ['brand-guidelines'] }] } }));
    const seedManifest = await validateCanvasPluginPackage(seedRoot);
    assert(seedManifest.valid && seedManifest.manifest);
    assert.equal((await parsePluginSkillsFromManifest(seedManifest.manifest, seedRoot, seedManifest.skillsDir)).errors.length, 0,
      'Explicit seed references use the actual parsed seed inventory.');
    await write(pluginRoot, '.canvas-plugin/plugin.json', JSON.stringify({ ...manifest,
      workflow: { ...workflow(), integrationCapabilities: [{ ...group(), skillRefs: ['brand-guidelines'] }] } }));
    await assert.rejects(validateCompleteCapabilityPackage('plugin', pluginRoot), /skill reference/, 'Seed names cannot implicitly import an undeclared skill.');

    const standaloneRoot = path.join(root, 'packages', 'standalone-workflow');
    const standalone = { version: 1, mcpConnectors: [{ name: 'canva-mcp', required: false, configPath: './connectors/canva.json', env: ['CANVA_TOKEN'], oauth: true }],
      integrationCapabilities: [{ ...group(), skillRefs: ['standalone-workflow'] }] };
    await skill(standaloneRoot, 'standalone-workflow', standalone); await write(standaloneRoot, 'connectors/canva.json', '{}');
    const standaloneValid = await validateCompleteCapabilityPackage('skill', standaloneRoot);
    assert.equal(standaloneValid.workflowDeclarations?.[0].declarationPath, 'agents/canvas.yaml');
    assert.equal((await loadCanvasSkillWorkflow(standaloneRoot))?.mcpConnectors?.[0].oauth, true);
    const missingOwn = { ...standalone, integrationCapabilities: [{ ...group(), skillRefs: ['foreign-skill'] }] };
    await write(standaloneRoot, 'agents/canvas.yaml', YAML.stringify({ workflow: missingOwn }));
    const structural = await parseSkillFile(path.join(standaloneRoot, 'SKILL.md'));
    assert(structural, 'The structural reader defers references until the caller has standalone/parent context.');
    await assert.rejects(validateStandaloneSkillWorkflow(structural), /skill reference/);
    await assert.rejects(validateCompleteCapabilityPackage('skill', standaloneRoot), /skill reference/);
    await write(standaloneRoot, 'agents/canvas.yaml', 'interface: [\n');
    assert.equal(await loadCanvasSkillWorkflow(standaloneRoot), undefined);
    assert(await parseSkillFile(path.join(standaloneRoot, 'SKILL.md')), 'Malformed legacy UI-only YAML retains the frontmatter parser contract.');
    for (const malformed of ['workflow: [\n', 'interface: [\nworkflow:\n  version: 1\n', 'workflow:\n  version: 1\n  version: 1\n  integrationCapabilities: []\n']) {
      await write(standaloneRoot, 'agents/canvas.yaml', malformed);
      await assert.rejects(loadCanvasSkillWorkflow(standaloneRoot), isWorkflowManifestError);
      const diagnostics: string[] = [];
      assert.equal(await parseSkillFile(path.join(standaloneRoot, 'SKILL.md'), { onDiagnostic: message => diagnostics.push(message) }), null);
      assert(diagnostics.some(message => message.includes('workflow')));
    }
    await write(standaloneRoot, 'agents/canvas.yaml', YAML.stringify({ workflow: standalone }));
    await fs.rm(path.join(standaloneRoot, 'connectors/canva.json'));
    await assert.rejects(validateCompleteCapabilityPackage('skill', standaloneRoot), /regular file inside/);
    await write(standaloneRoot, 'connectors/canva.json', '{}');

    const { importSkillPackage } = await import('../app/lib/skills/skill-package-import');
    const { readCanvasSkillRegistry, installCanvasSkillFromStore } = await import('../app/lib/skills/canvas-skill-store');
    const { installCanvasSkillFromWorkspace } = await import('../app/lib/skills/agent-skill-workspace');
    const badRoot = path.join(root, 'workspace', 'drafts', 'bad-workflow');
    await skill(badRoot, 'bad-workflow', { ...standalone, integrationCapabilities: [{ ...group(), skillRefs: ['foreign-skill'] }] });
    await write(badRoot, 'connectors/canva.json', '{}');
    const files = await Promise.all(['SKILL.md', 'agents/canvas.yaml', 'connectors/canva.json', 'scripts/task.js'].map(async relativePath =>
      ({ relativePath, bytes: await fs.readFile(path.join(badRoot, relativePath)) })));
    await assert.rejects(importSkillPackage({ kind: 'folder', files }, { scope: { userId: 'alice' }, enable: false }), /workflow.*skill reference/i);
    await assert.rejects(installCanvasSkillFromWorkspace({ workspaceRoot: path.join(root, 'workspace'), scope: { userId: 'alice' },
      draftPath: 'drafts/bad-workflow', enable: false }), /workflow.*skill reference/i);
    const zip = new JSZip(); for (const file of files) zip.file(`bad-workflow/${file.relativePath}`, file.bytes);
    const archivePath = path.join(root, 'store', 'bad-workflow.zip'); await write(root, 'store/bad-workflow.zip', await zip.generateAsync({ type: 'nodebuffer' }));
    const registryPath = path.join(root, 'store', 'registry.json');
    await write(root, 'store/registry.json', JSON.stringify({ schemaVersion: 1, id: 'workflow-store', name: 'Workflow fixture store', updatedAt: '2026-10-06T00:00:00.000Z', plugins: [],
      skills: [{ name: 'bad-workflow', description: 'Invalid workflow', latestVersion: '1.0.0',
        versions: { '1.0.0': { version: '1.0.0', checksum: `sha256:${await computeCanvasPluginChecksum(badRoot)}`, downloadUrl: pathToFileURL(archivePath).toString(), packagePath: 'bad-workflow' } } }] }));
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = pathToFileURL(registryPath).toString();
    const storeResult = await installCanvasSkillFromStore('bad-workflow', '1.0.0', { scope: { userId: 'alice' }, enable: false });
    assert.equal(storeResult.success, false); assert.match(storeResult.error ?? '', /workflow.*skill reference/i);
    assert.equal((await readCanvasSkillRegistry({ userId: 'alice' })).skills['bad-workflow'], undefined);
    console.log('PASS workflow contract: actual full-package/parser/install/upload/store/workspace validation, isolated PostgreSQL, separate parent/child scopes, strict bounds, exact refs, legacy preservation and OR/AND groups.');
  } finally {
    loader._load = original;
    await database.close(); await fs.rm(root, { recursive: true, force: true });
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
