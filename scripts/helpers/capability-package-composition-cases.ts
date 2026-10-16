import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { SqlConnection } from '../../app/lib/db';
import type { CapabilityPackageDraft } from '../../app/lib/capabilities/packages/contracts';

type Packages = typeof import('../../app/lib/capabilities/packages/actions');
type Actor = { userId: string; workspaceId: string };
type RequestFactory = (userId: string | null, method?: string, body?: unknown, url?: string) => Request;
const image = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Context</title><desc>A context document</desc><rect x="8" y="4" width="48" height="56" fill="#184E77"/></svg>';
const skill = (name: string, text = 'Prepare a document from the supplied context.') =>
  `---\nname: ${name}\ndescription: Prepare a document from supplied facts\nmetadata:\n  version: "1.0.0"\n---\n${text}\n`;

/** Composition is checked against real package IO, ACL and a complete authenticated HTTP batch. */
export async function verifyCapabilityPackageComposition(input: {
  packages: Packages; raw: Pick<SqlConnection, 'get' | 'all' | 'run'>;
  owner: Actor; other: Actor; request: RequestFactory; root: string;
}) {
  const { packages, raw, owner, other, request, root } = input;
  const composition = await import('../../app/lib/capabilities/packages/composition');
  const route = await import('../../app/api/capabilities/packages/drafts/[draftRef]/compose-skills/route');
  const write = async (draft: CapabilityPackageDraft, files: Record<string, string>) => {
    let current = draft;
    for (const [file, content] of Object.entries(files)) {
      ({ draft: current } = await packages.writeCapabilityPackageDraftFileAction(owner, current.draftRef, {
        path: file, encoding: 'base64', content: Buffer.from(content).toString('base64'), expectedDraftRevision: current.draftRevision,
      }));
    }
    return current;
  };
  const create = (kind: 'skill' | 'plugin', targetName: string) => packages.createCapabilityPackageDraftAction(owner,
    { operation: 'create', kind, targetName, requestId: randomUUID() });
  const publish = (draft: CapabilityPackageDraft) => packages.publishCapabilityPackageDraftAction(owner, {
    draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision, expectedMetadataRevision: 0,
    expectedGrantsRevision: 0, expectedPackageRevision: 0, expectedPublishedRevisionRef: null, requestId: randomUUID(),
  });
  const manifest = (name: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, name, version: '1.0.0', description: 'Composition fixture',
    skills: 'skills', interface: { displayName: 'Composed Context', shortDescription: 'Use complete bundled context skills', logo: './assets/base.svg' }, ...extra });
  const pluginFiles = (name: string) => ({ '.canvas-plugin/plugin.json': JSON.stringify(manifest(name)),
    'skills/new-context/SKILL.md': skill('new-context'), 'assets/base.svg': image });
  const read = async (draft: CapabilityPackageDraft, file: string) => Buffer.from(
    (await packages.readCapabilityPackageDraftFileAction(owner, draft.draftRef, { path: file })).file.content, 'base64').toString();

  const standalone = await write(await create('skill', 'composed-research'), {
    'SKILL.md': skill('composed-research', 'Read references/method.md and use the research service.'),
    'references/method.md': 'Cite the actual source.\n',
    'scripts/research.js': 'process.stdout.write("research-helper");\n',
    'connectors/research.json': JSON.stringify({ mcpServers: { research: { url: 'https://research.example.test/mcp' } } }),
    'agents/canvas.yaml': YAML.stringify({ skill: { version: '1.0.0' }, workflow: { version: 1,
      mcpConnectors: [{ name: 'research', configPath: 'connectors/research.json', required: true }],
      integrationCapabilities: [{ id: 'research', application: 'research', required: true,
        alternatives: [{ source: 'mcp', connector: 'research' }], skillRefs: ['composed-research'] }] } }),
  });
  const standalonePublished = await publish(standalone);
  let target = await write(await create('plugin', 'composed-suite'), pluginFiles('composed-suite'));
  const selection = { source: { resourceRef: standalone.resourceRef, revisionRef: standalonePublished.published.revisionRef,
    expectedChecksum: standalonePublished.published.checksum }, targetVersion: '1.0.1' };
  const onlyExisting = await write(await create('plugin', 'composed-existing-only'), {
    '.canvas-plugin/plugin.json': JSON.stringify(manifest('composed-existing-only')), 'assets/base.svg': image,
  });
  const onlyImported = await composition.composeCapabilityPackageSkillsAction(owner, onlyExisting.draftRef, {
    expectedDraftRevision: onlyExisting.draftRevision, skills: [selection],
  });
  assert((await packages.validateCapabilityPackageDraftAction(owner, onlyImported.draft.draftRef)).validation.valid,
    'A plugin can be composed exclusively from existing skills without a temporary starter skill.');
  await publish(onlyImported.draft);
  const before = target.draftRevision;
  const targetContext = { params: Promise.resolve({ draftRef: target.draftRef }) };
  for (const [body, status] of [
    [{ expectedDraftRevision: before, skills: [selection], rootPath: '/tmp/untrusted-package' }, 400],
    [{ expectedDraftRevision: before - 1, skills: [selection] }, 409],
    [{ expectedDraftRevision: before, skills: [{ ...selection, source: { ...selection.source, expectedChecksum: '0'.repeat(64) } }] }, 409],
    [{ expectedDraftRevision: before, skills: [{ ...selection, source: { ...selection.source, childRelativeRoot: '../escape' } }] }, 400],
    [{ expectedDraftRevision: before, skills: [selection], padding: 'x'.repeat(256 * 1024) }, 413],
  ] as const) {
    const rejected = await route.POST(request(owner.userId, 'POST', body), targetContext);
    assert.equal(rejected.status, status, await rejected.clone().text());
    assert.equal((await packages.readCapabilityPackageDraftAction(owner, target.draftRef)).draft.draftRevision, before);
  }
  const response = await route.POST(request(owner.userId, 'POST', { expectedDraftRevision: before, skills: [selection] }),
    targetContext);
  assert.equal(response.status, 200, await response.clone().text());
  target = (await response.json() as { data: { draft: CapabilityPackageDraft } }).data.draft;
  assert.equal(target.draftRevision, before + 1, 'The entire composition advances one SQL/COW generation.');
  assert.equal(await read(target, 'skills/new-context/SKILL.md'), skill('new-context'), 'Existing newly authored skills remain intact.');
  assert.equal(await read(target, 'skills/composed-research/references/method.md'), 'Cite the actual source.\n');
  assert.match(await read(target, 'skills/composed-research/scripts/research.js'), /research-helper/u);
  const child = YAML.parse(await read(target, 'skills/composed-research/agents/canvas.yaml'));
  assert.equal(child.workflow.mcpConnectors, undefined, 'Standalone connector declarations must move to the parent.');
  assert.equal(child.skill.version, '1.0.1');
  assert.match(await read(target, 'skills/composed-research/SKILL.md'), /version: ["']?1\.0\.1/u);
  let parent = JSON.parse(await read(target, '.canvas-plugin/plugin.json'));
  assert.equal(parent.schemaVersion, 1, 'Composition retains the exact declared Creator contract version.');
  const connector = parent.connectors.mcp.find((value: { name: string }) => value.name === 'research');
  assert(connector?.configPath); assert.match(await read(target, connector.configPath.replace(/^\.\//u, '')), /research\.example\.test/u);
  assert((await packages.validateCapabilityPackageDraftAction(owner, target.draftRef)).validation.valid);
  const sourceBytes = await packages.readCapabilityPackageFileAction(owner, standalone.resourceRef,
    { revisionRef: standalonePublished.published.revisionRef, path: 'agents/canvas.yaml' });
  assert.equal(YAML.parse(Buffer.from(sourceBytes.file.content, 'base64').toString()).skill.version, '1.0.0', 'Composition never mutates the source.');

  const parentName = 'composition-parent';
  const originalParent = await write(await create('plugin', parentName), {
    '.canvas-plugin/plugin.json': JSON.stringify(manifest(parentName, { connectors: { composio: [{ toolkit: 'hubspot', required: true }, { toolkit: 'slack', required: true }] },
      workflow: { version: 1, integrationCapabilities: [
        { id: 'crm', application: 'hubspot', required: true, alternatives: [{ source: 'composio', toolkit: 'hubspot' }], skillRefs: ['bundled-context'] },
        { id: 'unrelated', application: 'slack', required: true, alternatives: [{ source: 'composio', toolkit: 'slack' }], skillRefs: ['unrelated-context'] },
      ] } })),
    'assets/base.svg': image, 'assets/shared.svg': image,
    'skills/bundled-context/SKILL.md': skill('bundled-context', 'Use ../../assets/shared.svg as the context illustration.'),
    'skills/bundled-context/agents/canvas.yaml': YAML.stringify({ skill: { version: '1.0.0' }, interface: { icon_small: '../../assets/shared.svg' } }),
    'skills/unrelated-context/SKILL.md': skill('unrelated-context'),
  });
  const original = await publish(originalParent);
  const descriptor = await packages.inspectCapabilityPackage(owner, originalParent.resourceRef);
  const changed = await packages.createCapabilityPackageDraftAction(owner, { operation: 'edit', resourceRef: originalParent.resourceRef,
    expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
    expectedPackageRevision: original.state.packageRevision, expectedPublishedRevisionRef: original.published.revisionRef });
  const updated = await write(changed, {
    '.canvas-plugin/plugin.json': JSON.stringify(manifest(parentName, { version: '2.0.0', skills: 'next-skills' })),
    'next-skills/current-context/SKILL.md': skill('current-context'), 'assets/shared.svg': image.replace('#184E77', '#8B0000'),
  });
  await packages.publishCapabilityPackageDraftAction(owner, { draftRef: updated.draftRef, expectedDraftRevision: updated.draftRevision,
    expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
    expectedPackageRevision: original.state.packageRevision, expectedPublishedRevisionRef: original.published.revisionRef });
  const historical = await composition.composeCapabilityPackageSkillsAction(owner, target.draftRef, {
    expectedDraftRevision: target.draftRevision, skills: [{ source: { resourceRef: originalParent.resourceRef,
      revisionRef: original.published.revisionRef, expectedChecksum: original.published.checksum, childRelativeRoot: 'skills/bundled-context' } }],
  });
  target = historical.draft;
  const historicalIcon = YAML.parse(await read(target, 'skills/bundled-context/agents/canvas.yaml')).interface.icon_small;
  const iconPath = path.posix.normalize(path.posix.join('skills/bundled-context', historicalIcon));
  assert.equal(await read(target, iconPath), image, 'Capture uses assets from the selected old parent, even when its child disappeared from the current catalog.');
  parent = JSON.parse(await read(target, '.canvas-plugin/plugin.json'));
  assert(parent.workflow.integrationCapabilities.some((value: { application: string }) => value.application === 'hubspot'));
  assert(!parent.workflow.integrationCapabilities.some((value: { application: string }) => value.application === 'slack'));
  assert(!parent.connectors.composio.some((value: { toolkit: string }) => value.toolkit === 'slack'), 'Unrelated required parent connections must not become requirements of the selected child.');
  const stableRevision = target.draftRevision, stableManifest = await read(target, '.canvas-plugin/plugin.json');
  await assert.rejects(composition.composeCapabilityPackageSkillsAction(owner, target.draftRef, {
    expectedDraftRevision: stableRevision, skills: [
      { ...selection, targetName: 'uncommitted-copy', targetVersion: '1.0.2' },
      { ...selection, targetName: 'new-context', targetVersion: '1.0.1' },
    ],
  }));
  assert.equal((await packages.readCapabilityPackageDraftAction(owner, target.draftRef)).draft.draftRevision, stableRevision);
  assert.equal(await read(target, '.canvas-plugin/plugin.json'), stableManifest, 'A conflict leaves the original complete draft unchanged.');
  assert(!(await packages.listCapabilityPackageDraftFilesAction(owner, target.draftRef)).files.some(file => file.path.startsWith('skills/uncommitted-copy/')));
  const forbidden = await route.POST(request(other.userId, 'POST', { expectedDraftRevision: stableRevision, skills: [selection] }),
    { params: Promise.resolve({ draftRef: target.draftRef }) });
  assert.equal(forbidden.status, 404);
  assert((await packages.validateCapabilityPackageDraftAction(owner, target.draftRef)).validation.valid);
  const completed = await publish(target);
  assert.equal(completed.published.kind, 'plugin');

  const linkedParent = await write(await create('plugin', 'composition-linked'), {
    '.canvas-plugin/plugin.json': JSON.stringify(manifest('composition-linked', {
      connectors: { mcp: [{ name: 'linked-research', configPath: './skills/linked-a/connectors/research.json', required: true }] },
      workflow: { version: 1, integrationCapabilities: [{ id: 'shared-research', application: 'research', required: true,
        alternatives: [{ source: 'mcp', connector: 'linked-research' }], skillRefs: ['linked-a', 'linked-b'] }] },
    })),
    'assets/base.svg': image,
    'skills/linked-a/SKILL.md': skill('linked-a', 'Read [shared method](../shared/method.md).'),
    'skills/linked-a/connectors/research.json': JSON.stringify({ mcpServers: { 'linked-research': { url: 'https://research.example.test/mcp' } } }),
    'skills/linked-a/agents/canvas.yaml': YAML.stringify({ skill: { version: '1.0.0' }, workflow: { version: 1,
      integrationCapabilities: [{ id: 'linked-followup', application: 'research', required: true,
        alternatives: [{ source: 'mcp', connector: 'linked-research' }], skillRefs: ['linked-b'] }] } }),
    'skills/linked-b/SKILL.md': skill('linked-b'), 'skills/shared/method.md': 'Shared exact source method.\n',
  });
  const linkedPublished = await publish(linkedParent);
  const linkedTarget = await write(await create('plugin', 'composition-linked-copy'), pluginFiles('composition-linked-copy'));
  const linked = await composition.composeCapabilityPackageSkillsAction(owner, linkedTarget.draftRef, {
    expectedDraftRevision: linkedTarget.draftRevision, skills: ['linked-a', 'linked-b'].map(name => ({
      source: { resourceRef: linkedParent.resourceRef, revisionRef: linkedPublished.published.revisionRef,
        expectedChecksum: linkedPublished.published.checksum, childRelativeRoot: `skills/${name}` },
      ...(name === 'linked-b' ? { targetName: 'linked-renamed' } : {}),
    })),
  });
  const linkedManifest = JSON.parse(await read(linked.draft, '.canvas-plugin/plugin.json'));
  assert.deepEqual([...linkedManifest.workflow.integrationCapabilities.find((value: { id: string }) => value.id === 'shared-research').skillRefs].sort(),
    ['linked-a', 'linked-renamed'], 'The same parent capability merges the selected child associations.');
  const linkedYaml = YAML.parse(await read(linked.draft, 'skills/linked-a/agents/canvas.yaml'));
  assert.deepEqual(linkedYaml.workflow.integrationCapabilities[0].skillRefs, ['linked-renamed'], 'A cross-skill rename persists in unchanged-name children.');
  assert.notEqual(linkedYaml.skill.version, '1.0.0', 'The changed workflow gets an independent derived version.');
  const linkedBody = await read(linked.draft, 'skills/linked-a/SKILL.md');
  const sharedLink = /\[shared method\]\(([^)]+)\)/u.exec(linkedBody)?.[1]; assert(sharedLink);
  assert.equal(await read(linked.draft, path.posix.normalize(path.posix.join('skills/linked-a', sharedLink))), 'Shared exact source method.\n');
  const linkedConfig = linkedManifest.connectors.mcp.find((value: { name: string }) => value.name === 'linked-research').configPath;
  assert.match(await read(linked.draft, linkedConfig.replace(/^\.\//u, '')), /research\.example\.test/u);
  assert((await packages.validateCapabilityPackageDraftAction(owner, linked.draft.draftRef)).validation.valid);
  await publish(linked.draft);

  const resources = await import('../../app/lib/capabilities/resources/actions');
  const registry = await import('../../app/lib/plugins/canvas-plugin-registry');
  const unsafeRoot = path.join(root, 'fixtures', 'composition-private-config');
  await fs.mkdir(path.join(unsafeRoot, '.canvas-plugin'), { recursive: true });
  await fs.mkdir(path.join(unsafeRoot, 'skills', 'config-context'), { recursive: true });
  await fs.mkdir(path.join(unsafeRoot, 'connectors'), { recursive: true });
  await fs.writeFile(path.join(unsafeRoot, '.canvas-plugin/plugin.json'), JSON.stringify({
    name: 'composition-private-config', version: '1.0.0', description: 'Legacy configuration boundary', skills: 'skills',
    connectors: { mcp: [{ name: 'research', configPath: './connectors/research.json', required: true }] },
  }));
  await fs.writeFile(path.join(unsafeRoot, 'skills/config-context/SKILL.md'), skill('config-context'));
  await fs.writeFile(path.join(unsafeRoot, 'connectors/research.json'), JSON.stringify({ mcpServers: {
    research: { url: 'https://research.example.test/mcp' },
    unselected: { url: 'https://research.example.test/other', headers: { Authorization: 'fixture-private-value' } },
  } }));
  const unsafeInstalled = await registry.installCanvasPluginFromPath(unsafeRoot, {
    scope: { scopeType: 'user', userId: owner.userId }, enable: false,
  });
  assert(unsafeInstalled.success && unsafeInstalled.plugin?.resourceId);
  const unsafeDescriptor = await packages.inspectCapabilityPackage(owner, unsafeInstalled.plugin.resourceId);
  const unsafeTarget = await write(await create('plugin', 'composition-safe-target'), pluginFiles('composition-safe-target'));
  await assert.rejects(composition.composeCapabilityPackageSkillsAction(owner, unsafeTarget.draftRef, {
    expectedDraftRevision: unsafeTarget.draftRevision, skills: [{ source: {
      resourceRef: unsafeDescriptor.resource.resourceRef, expectedChecksum: unsafeDescriptor.sourceStamp.checksum,
      childRelativeRoot: 'skills/config-context',
    } }],
  }), error => ['PACKAGE_INVALID', 'PACKAGE_REQUEST_INVALID'].includes((error as { code: string }).code),
  'Every copied MCP server entry must be checked, including an unselected entry in the same configuration file.');
  assert.equal((await packages.readCapabilityPackageDraftAction(owner, unsafeTarget.draftRef)).draft.draftRevision, unsafeTarget.draftRevision);
  await fs.writeFile(path.join(unsafeInstalled.plugin.installDir, 'connectors/research.json'), JSON.stringify({
    mcpServers: { research: { url: 'https://research.example.test/mcp' } }, token: 'fixture-private-value',
  }));
  const unsafeWrapper = await packages.inspectCapabilityPackage(owner, unsafeInstalled.plugin.resourceId);
  await assert.rejects(composition.composeCapabilityPackageSkillsAction(owner, unsafeTarget.draftRef, {
    expectedDraftRevision: unsafeTarget.draftRevision, skills: [{ source: {
      resourceRef: unsafeWrapper.resource.resourceRef, expectedChecksum: unsafeWrapper.sourceStamp.checksum,
      childRelativeRoot: 'skills/config-context',
    } }],
  }), error => ['PACKAGE_INVALID', 'PACKAGE_REQUEST_INVALID'].includes((error as { code: string }).code),
  'Private fields outside the mcpServers wrapper must not be copied either.');
  await fs.writeFile(path.join(unsafeInstalled.plugin.installDir, 'connectors/research.json'), JSON.stringify({
    mcpServers: { research: { url: 'https://research.example.test/mcp' } },
  }));
  const legacyConnectorManifest = JSON.parse(await fs.readFile(path.join(unsafeInstalled.plugin.installDir, '.canvas-plugin/plugin.json'), 'utf8'));
  legacyConnectorManifest.connectors = { mcp_servers: './connectors/research.json' };
  await fs.writeFile(path.join(unsafeInstalled.plugin.installDir, '.canvas-plugin/plugin.json'), JSON.stringify(legacyConnectorManifest));
  const legacyConnectorSource = await packages.inspectCapabilityPackage(owner, unsafeInstalled.plugin.resourceId);
  const legacyComposed = await composition.composeCapabilityPackageSkillsAction(owner, unsafeTarget.draftRef, {
    expectedDraftRevision: unsafeTarget.draftRevision, skills: [{ source: {
      resourceRef: legacyConnectorSource.resource.resourceRef, expectedChecksum: legacyConnectorSource.sourceStamp.checksum,
      childRelativeRoot: 'skills/config-context',
    } }],
  });
  const legacyComposedManifest = JSON.parse(await read(legacyComposed.draft, '.canvas-plugin/plugin.json'));
  assert.equal(legacyComposedManifest.schemaVersion, 1);
  assert.equal(legacyComposedManifest.connectors?.mcpServers, undefined, 'A new Creator target contains canonical modern declarations.');
  const legacyConfigPath = legacyComposedManifest.connectors?.mcp?.find((connector: { name: string }) => connector.name === 'research')?.configPath;
  assert(legacyConfigPath, 'Composing a legacy MCP recommendation must preserve its connection declaration.');
  assert.match(await read(legacyComposed.draft, legacyConfigPath.replace(/^\.\//u, '')), /research\.example\.test/u);
  assert((await packages.validateCapabilityPackageDraftAction(owner, legacyComposed.draft.draftRef)).validation.valid);
  await publish(legacyComposed.draft);
  await raw.run('UPDATE organization_user_permissions SET can_share_plugins_and_skills=1 WHERE user_id=$1', [other.userId]);
  const privateRoot = path.join(root, 'fixtures', 'composition-private');
  await fs.mkdir(path.join(privateRoot, '.canvas-plugin'), { recursive: true });
  await fs.mkdir(path.join(privateRoot, 'skills', 'private-context'), { recursive: true });
  await fs.writeFile(path.join(privateRoot, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'composition-private', version: '1.0.0', description: 'A privately shared source', skills: 'skills' }));
  await fs.writeFile(path.join(privateRoot, 'skills', 'private-context', 'SKILL.md'), skill('private-context'));
  const installed = await registry.installCanvasPluginFromPath(privateRoot, { scope: { scopeType: 'user', userId: other.userId }, enable: false });
  assert(installed.success && installed.plugin?.resourceId);
  const configured = await resources.configureCapabilityResource(other, installed.plugin.resourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
    accessMode: 'restricted', grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }] });
  const readable = await packages.inspectCapabilityPackage(owner, configured.metadata.resourceRef);
  let revokedTarget = await write(await create('plugin', 'composition-revoked'), pluginFiles('composition-revoked'));
  ({ draft: revokedTarget } = await composition.composeCapabilityPackageSkillsAction(owner, revokedTarget.draftRef, {
    expectedDraftRevision: revokedTarget.draftRevision, skills: [{ source: { resourceRef: configured.metadata.resourceRef,
      expectedChecksum: readable.sourceStamp.checksum, childRelativeRoot: 'skills/private-context' } }],
  }));
  await resources.updateCapabilityResource(other, configured.metadata.resourceRef, { expectedMetadataRevision: configured.metadata.metadataRevision,
    expectedGrantsRevision: configured.metadata.grantsRevision, grants: [] });
  await assert.rejects(publish(revokedTarget), error => (error as { status?: number }).status === 403,
    'Revoking a copied source must be checked again before the target is first published.');
  assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_resources WHERE resource_ref=$1', [revokedTarget.resourceRef]) as { count: number }).count, 0);

  const workspaces = await import('../../app/lib/workspaces/postgres-runtime');
  const workspace = await workspaces.resolveExistingPostgresWorkspaceForActor({ userId: owner.userId, role: 'owner' }, owner.workspaceId);
  assert(workspace); await fs.mkdir(workspace.rootPath, { recursive: true });
  const legacy = await import('../../app/lib/plugins/agent-plugin-workspace');
  const legacyDraft = await legacy.createCanvasPluginDraft({ workspaceRoot: workspace.rootPath,
    pluginName: 'composition-imported', draftId: 'legacy-import-source', description: 'A legacy plugin draft' });
  const selector = { kind: 'plugin', workspaceDraftId: legacyDraft.draftId, packageName: legacyDraft.pluginName };
  const inspected = await composition.inspectCapabilityPackageWorkspaceDraftAction(owner, selector);
  const workspaceRoute = await import('../../app/api/capabilities/packages/workspace-drafts/inspect/route');
  const inspectedResponse = await workspaceRoute.GET(request(owner.userId, 'GET', undefined,
    `http://localhost/api/capabilities/packages/workspace-drafts/inspect?${new URLSearchParams({ ...selector, workspaceId: owner.workspaceId })}`), { params: Promise.resolve({}) });
  assert.equal(inspectedResponse.status, 200, await inspectedResponse.clone().text());
  const visibleInspection = await inspectedResponse.json() as { data: { source: { checksum: string } } };
  assert.equal(visibleInspection.data.source.checksum, inspected.source.checksum);
  assert(!JSON.stringify(visibleInspection).includes(workspace.rootPath), 'Discovery returns a checksum without exposing server filesystem authority.');
  const importTarget = await create('plugin', legacyDraft.pluginName);
  const imported = await composition.importCapabilityPackageWorkspaceDraftAction(owner, importTarget.draftRef, {
    expectedDraftRevision: importTarget.draftRevision, source: selector, expectedChecksum: inspected.source.checksum,
  });
  assert.equal(imported.draft.draftRevision, importTarget.draftRevision + 1);
  assert.match(await read(imported.draft, '.canvas-plugin/plugin.json'), /composition-imported/u);
  assert.equal(await fs.readFile(path.join(workspace.rootPath, legacyDraft.packagePath, '.canvas-plugin/plugin.json'), 'utf8'),
    await read(imported.draft, '.canvas-plugin/plugin.json'), 'Import preserves the old workspace draft without installing or deleting it.');
  await assert.rejects(composition.importCapabilityPackageWorkspaceDraftAction(owner, imported.draft.draftRef, {
    expectedDraftRevision: imported.draft.draftRevision, source: selector, expectedChecksum: inspected.source.checksum,
  }), 'Import cannot overwrite a nonempty package draft.');
  await assert.rejects(composition.inspectCapabilityPackageWorkspaceDraftAction(owner, { ...selector, workspaceDraftId: '../escape' }));
  const unsafeWorkspace = await legacy.createCanvasPluginDraft({ workspaceRoot: workspace.rootPath,
    pluginName: 'composition-unsafe-import', draftId: 'legacy-unsafe-import', description: 'Unsafe legacy configuration' });
  const unsafeWorkspaceRoot = path.join(workspace.rootPath, unsafeWorkspace.packagePath);
  const unsafeWorkspaceManifest = JSON.parse(await fs.readFile(path.join(unsafeWorkspaceRoot, '.canvas-plugin/plugin.json'), 'utf8'));
  unsafeWorkspaceManifest.connectors = { mcp: [{ name: 'research', configPath: './research.json' }] };
  await fs.writeFile(path.join(unsafeWorkspaceRoot, '.canvas-plugin/plugin.json'), JSON.stringify(unsafeWorkspaceManifest));
  await fs.writeFile(path.join(unsafeWorkspaceRoot, 'research.json'), JSON.stringify({ url: 'https://research.example.test/mcp',
    headers: { Authorization: 'fixture-private-value' } }));
  const unsafeImportTarget = await create('plugin', unsafeWorkspace.pluginName);
  const inventory = await import('../../app/lib/capabilities/packages/io');
  const unsafeInventory = await inventory.readExactPackageInventory(unsafeWorkspaceRoot);
  await assert.rejects(composition.importCapabilityPackageWorkspaceDraftAction(owner, unsafeImportTarget.draftRef, {
    expectedDraftRevision: unsafeImportTarget.draftRevision,
    source: { kind: 'plugin', workspaceDraftId: unsafeWorkspace.draftId, packageName: unsafeWorkspace.pluginName },
    expectedChecksum: unsafeInventory.checksum,
  }), error => ['PACKAGE_INVALID', 'PACKAGE_REQUEST_INVALID'].includes((error as { code: string }).code),
  'An explicit legacy import must enforce the same private configuration boundary.');
  assert.equal((await packages.listCapabilityPackageDraftFilesAction(owner, unsafeImportTarget.draftRef)).files.length, 0);
  const legacySkills = await import('../../app/lib/skills/agent-skill-workspace');
  const legacySkill = await legacySkills.createCanvasSkillDraft({ workspaceRoot: workspace.rootPath,
    scope: { userId: owner.userId, organizationId: 'org-packages' }, skillName: 'composition-imported-skill',
    draftId: 'legacy-skill-source', description: 'An independently imported legacy skill' });
  const legacySkillRoot = path.join(workspace.rootPath, legacySkill.packagePath);
  await fs.writeFile(path.join(legacySkillRoot, 'connectors.json'), JSON.stringify({ url: 'https://research.example.test/mcp' }));
  await fs.writeFile(path.join(legacySkillRoot, 'agents/canvas.yaml'), YAML.stringify({ skill: { version: '1.0.0' }, workflow: { version: 1,
    mcpConnectors: [{ name: 'research', configPath: './connectors.json' }],
    integrationCapabilities: [{ id: 'research', application: 'research', required: true,
      alternatives: [{ source: 'mcp', connector: 'research' }], skillRefs: [legacySkill.skillName] }] } }));
  const legacySkillOriginal = await fs.readFile(path.join(legacySkillRoot, 'SKILL.md'), 'utf8');
  const skillSelector = { kind: 'skill', workspaceDraftId: legacySkill.draftId, packageName: legacySkill.skillName };
  const inspectedSkill = await composition.inspectCapabilityPackageWorkspaceDraftAction(owner, skillSelector);
  const skillTarget = await create('skill', 'composition-imported-skill-copy');
  const importRoute = await import('../../app/api/capabilities/packages/drafts/[draftRef]/import-workspace/route');
  const importedResponse = await importRoute.POST(request(owner.userId, 'POST', {
    expectedDraftRevision: skillTarget.draftRevision, source: skillSelector, expectedChecksum: inspectedSkill.source.checksum,
  }, `http://localhost/api/capabilities/packages/drafts/${encodeURIComponent(skillTarget.draftRef)}/import-workspace?workspaceId=${owner.workspaceId}`),
  { params: Promise.resolve({ draftRef: skillTarget.draftRef }) });
  assert.equal(importedResponse.status, 200, await importedResponse.clone().text());
  const importedSkill = (await importedResponse.json() as { data: { draft: CapabilityPackageDraft } }).data.draft;
  assert.equal(importedSkill.draftRevision, skillTarget.draftRevision + 1);
  assert.equal(await fs.readFile(path.join(legacySkillRoot, 'SKILL.md'), 'utf8'), legacySkillOriginal);
  assert.match(await read(importedSkill, 'SKILL.md'), /name: composition-imported-skill-copy/u);
  const importedSkillYaml = YAML.parse(await read(importedSkill, 'agents/canvas.yaml'));
  assert.deepEqual(importedSkillYaml.workflow.integrationCapabilities[0].skillRefs, ['composition-imported-skill-copy']);
  assert.notEqual(importedSkillYaml.skill.version, '1.0.0', 'Renaming an imported skill derives a new independent version.');
  assert((await packages.validateCapabilityPackageDraftAction(owner, importedSkill.draftRef)).validation.valid);
  await publish(importedSkill);
  console.log('PASS package composition: complete skills, connector hoist, exact historical parent/assets, relevant requirements, unchanged sources, atomic conflicts, fresh source ACL and explicit legacy import.');
}
