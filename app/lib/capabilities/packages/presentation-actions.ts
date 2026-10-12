import 'server-only';

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '@/app/lib/db';
import { authority } from '../scope-authority';
import type { CapabilityResourceActor, CapabilityResourceStorageBinding } from '../resources/contracts';
import { capabilityResourceStorageBinding } from '../resources/storage-binding';
import { withAuthorizedCapabilityPackageResource } from '../resources/store';
import { validateCanvasPluginPackage, type CanvasPluginConnectorManifest, type CanvasPluginMcpConnector } from '@/app/lib/plugins/canvas-plugin-manifest';
import { parsePluginSkillsFromManifest } from '@/app/lib/plugins/canvas-plugin-registry';
import { normalizeComposioConnectors, normalizeEmailConnectors, normalizeMcpConnectors } from '@/app/lib/plugins/plugin-connection-readiness';
import { parseSkillFile, validateStandaloneSkillWorkflow, type CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import { validateWorkflowReferences, type GenericWorkflowManifestV1, type SkillWorkflowManifestV1 } from '../workflow-contracts';
import { readSkillScriptManifest } from '@/app/lib/skills/script-runtime/manifest';
import { isSkillScriptError } from '@/app/lib/skills/script-runtime/contracts';
import { readCanvasPluginStoreRegistry } from '@/app/lib/plugins/canvas-plugin-store';
import { readCanvasSkillStoreRegistry } from '@/app/lib/skills/canvas-skill-store';
import { prepareVerifiedCanvasPluginStorePackage, prepareVerifiedCanvasSkillStorePackage } from '@/app/lib/plugins/store-package-preparation';
import { capabilityStoreRegistryIdentity } from './store-origin';
import { assertPreparedCapabilityStorePackage, disposePreparedCapabilityStorePackage, getPreparedCapabilityStorePackage } from './store-source';
import { capabilityPackageReferenceSchema } from './schemas';
import { CapabilityPackageError } from './contracts';
import { copyCapabilityPackageSourceWithReferences, readExactPackageInventory } from './io';
import { assertCapabilityPackageArtifactCurrent, resolveCapabilityPackageArtifact, type ResolvedCapabilityPackageArtifact } from './artifacts';
import { CAPABILITY_PACKAGE_PRESENTATION_LIMITS as limits, capabilityPackageStoreOfferingPresentationSchema,
  type CapabilityPackagePresentation, type CapabilityPackagePresentationDeclaration } from './presentation-contracts';

const changed = () => new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The package source changed. Inspect it again.', 409);
const invalid = () => new CapabilityPackageError('PACKAGE_INVALID', 'The package presentation is unavailable.', 400);
const boundedText = (value: string | undefined, max: number): string | undefined => value
  ? Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '').trim()).slice(0, max).join('') || undefined : undefined;
const envKey = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;

function actorSnapshot(input: CapabilityResourceActor): CapabilityResourceActor {
  if (!input || typeof input.userId !== 'string' || !input.userId || input.userId.length > 256
    || input.userId !== input.userId.trim() || /[\u0000-\u001f\u007f]/u.test(input.userId)
    || input.workspaceId !== undefined && input.workspaceId !== null && (typeof input.workspaceId !== 'string'
      || !input.workspaceId || input.workspaceId.length > 256 || input.workspaceId !== input.workspaceId.trim()
      || /[\u0000-\u001f\u007f]/u.test(input.workspaceId))) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'An active actor and workspace are required.', 403);
  }
  return Object.freeze({userId: input.userId, workspaceId: input.workspaceId ?? null});
}
async function assertActor(actor: CapabilityResourceActor): Promise<void> {
  const database = await openDb();
  try {
    const current = await authority(database, actor);
    if (!current.valid || !current.contextValid) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'An active actor and workspace are required.', 403);
  } finally { await database.close(); }
}
function enforceBounds(value: CapabilityPackagePresentation): CapabilityPackagePresentation {
  if (value.children.length > limits.children || value.capabilities.length > limits.capabilities
    || value.scripts.length > limits.scripts || value.requirements.length > limits.requirements
    || value.compatibility.length > limits.compatibility || value.requiredEnv.length > limits.envNames
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > limits.bytes) {
    throw new CapabilityPackageError('PACKAGE_LIMIT_EXCEEDED', 'The package presentation exceeds its size limit.', 413);
  }
  return value;
}

/** Only metadata is projected. Portable declarations are demands, never access or account bindings. */
type ParentPresentationContext = {name: string; connectors: CanvasPluginMcpConnector[]; connectorManifest?: CanvasPluginConnectorManifest; skillNames: string[]};
async function projectPresentation(kind: 'plugin' | 'skill', root: string, fallbackVersion: string, parent?: ParentPresentationContext): Promise<CapabilityPackagePresentation> {
  const result: CapabilityPackagePresentation = {schemaVersion: 1, origin: 'installed', kind, name: '', version: fallbackVersion,
    title: '', description: '', children: [], capabilities: [], requirements: [], scripts: [], compatibility: [], requiredEnv: [],
    readOnly: true, sourceStampCurrent: true};
  const keys = new Set<string>();
  let validatedSkillNames: readonly string[] = parent?.skillNames ?? [];
  const compatible = new Set<string>();
  const configurationKeys = (connectors: readonly {env?: readonly string[]}[]) => {
    for (const connector of connectors) for (const key of connector.env ?? []) if (typeof key === 'string' && envKey.test(key)) keys.add(key);
  };
  const legacy = (declaredBy: CapabilityPackagePresentationDeclaration, connectors?: CanvasPluginConnectorManifest) => {
    const mcp = normalizeMcpConnectors(connectors);
    configurationKeys(mcp);
    for (const connector of mcp) result.requirements.push({declaredBy, source: 'mcp', label: boundedText(connector.label || connector.name, limits.title) || 'MCP',
      required: connector.required === true, recommended: connector.recommended === true});
    for (const connector of normalizeComposioConnectors(connectors)) result.requirements.push({declaredBy, source: 'composio',
      label: boundedText(connector.label || connector.toolkit, limits.title) || 'Composio', required: connector.required === true, recommended: connector.recommended === true});
    for (const connector of normalizeEmailConnectors(connectors)) result.requirements.push({declaredBy, source: 'canvas-email',
      label: boundedText(connector.label, limits.title) || 'Canvas Email', required: connector.required === true, recommended: connector.recommended === true});
  };
  const workflow = (declaredBy: CapabilityPackagePresentationDeclaration, manifest: GenericWorkflowManifestV1 | undefined,
    connectors: readonly {name: string; label?: string}[]) => {
    for (const capability of manifest?.integrationCapabilities ?? []) result.capabilities.push({declaredBy, id: capability.id,
      application: capability.application, required: capability.required,
      alternatives: capability.alternatives.map(alternative => ({source: alternative.source, label: boundedText(alternative.source === 'mcp'
        ? connectors.find(connector => connector.name === alternative.connector)?.label || alternative.connector : alternative.toolkit, limits.title) || alternative.source}))});
  };
  const skillDetails = async (skill: CanvasSkill, parentConnectors: readonly CanvasPluginMcpConnector[], standalone: boolean) => {
    const by = {kind: 'skill' as const, name: skill.name};
    const ownConnectors = standalone ? (skill.workflow as SkillWorkflowManifestV1 | undefined)?.mcpConnectors ?? [] : [];
    if (standalone) {
      legacy(by, {mcp: ownConnectors.map(connector => ({...connector, env: connector.env ? [...connector.env] : undefined}))});
      await validateStandaloneSkillWorkflow(skill);
    }
    if (!standalone && skill.workflow) validateWorkflowReferences(skill.workflow, {mcpConnectors: parentConnectors, skillNames: validatedSkillNames.length ? validatedSkillNames : [skill.name], allowMcpConnectors: false});
    workflow(by, skill.workflow, standalone ? ownConnectors : parentConnectors);
    if (skill.compatibility) compatible.add(boundedText(skill.compatibility, 500) || '');
    try {
      const declared = await readSkillScriptManifest(skill.directory);
      for (const script of declared?.manifest.scripts ?? []) result.scripts.push({skillName: skill.name, id: script.id,
        title: boundedText(script.displayName || script.id, limits.title) || script.id,
        ...(script.description ? {description: boundedText(script.description, limits.description)} : {}),
        runtime: {...script.runtime}});
    } catch (error) { if (isSkillScriptError(error)) throw invalid(); throw error; }
  };
  if (parent) legacy({kind: 'plugin', name: parent.name}, parent.connectorManifest);
  if (kind === 'plugin') {
    const validated = await validateCanvasPluginPackage(root);
    if (!validated.valid || !validated.manifest) throw invalid();
    const manifest = validated.manifest;
    const parsed = await parsePluginSkillsFromManifest(manifest, root, validated.skillsDir);
    if (parsed.errors.length) throw invalid();
    validatedSkillNames = parsed.skills.map(skill => skill.name);
    result.name = manifest.name; result.version = manifest.version;
    result.title = boundedText(manifest.interface?.displayName || manifest.name, limits.title) || manifest.name;
    result.description = boundedText(manifest.description, limits.description) || '';
    const license = boundedText(manifest.license, limits.license); if (license) result.license = license;
    const by = {kind, name: manifest.name};
    legacy(by, manifest.connectors); workflow(by, manifest.workflow, manifest.connectors?.mcp ?? []);
    for (const skill of parsed.skills) {
      result.children.push({name: skill.name, title: boundedText(skill.title || skill.name, limits.title) || skill.name,
        description: boundedText(skill.description, limits.description) || '', ...(skill.version ? {version: skill.version} : {})});
      await skillDetails(skill, manifest.connectors?.mcp ?? [], false);
      enforceBounds(result);
    }
  } else {
    const skill = await parseSkillFile(path.join(root, 'SKILL.md'));
    if (!skill) throw invalid();
    result.name = skill.name; result.version = skill.version || fallbackVersion;
    result.title = boundedText(skill.title || skill.name, limits.title) || skill.name;
    result.description = boundedText(skill.description, limits.description) || '';
    const license = boundedText(skill.license, limits.license); if (license) result.license = license;
    await skillDetails(skill, parent?.connectors ?? [], !parent);
  }
  result.compatibility = [...compatible].filter(Boolean).sort();
  result.requiredEnv = [...keys].sort();
  return enforceBounds(result);
}

function parentStorage(source: ResolvedCapabilityPackageArtifact): CapabilityResourceStorageBinding | undefined {
  if (source.storage.sourceType !== 'plugin') return undefined;
  const parents = source.candidates.filter(candidate => candidate.ref.resourceType === 'plugin' && candidate.ref.resourceId === source.storage.sourcePluginId);
  if (parents.length !== 1) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The source plugin is unavailable.', 404);
  return capabilityResourceStorageBinding(parents[0].ref);
}
async function withCapturedPresentation<T>(source: ResolvedCapabilityPackageArtifact, callback: (root: string) => Promise<T>): Promise<T> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-package-presentation-'));
  const observed = await fs.lstat(temporary, {bigint: true});
  try {
    const root = path.join(temporary, source.storage.name);
    await copyCapabilityPackageSourceWithReferences(source.location, root, {expectedSourceChecksum: source.sourceStamp.checksum,
      bundledReferences: source.bundledReferences});
    return await callback(root);
  } finally {
    const current = await fs.lstat(temporary, {bigint: true});
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== observed.ino || current.dev !== observed.dev) throw changed();
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

export async function inspectCapabilityPackageStoreOfferingAction(actorInput: CapabilityResourceActor, value: unknown): Promise<CapabilityPackagePresentation> {
  const actor = actorSnapshot(actorInput), {source} = capabilityPackageStoreOfferingPresentationSchema.parse(structuredClone(value));
  await assertActor(actor);
  const resourceId = `canvas-store-presentation:${randomUUID()}`;
  const prepared = source.kind === 'plugin' ? await prepareVerifiedCanvasPluginStorePackage({...source, resourceId, actor})
    : await prepareVerifiedCanvasSkillStorePackage({...source, resourceId, actor});
  try {
    const privateSource = getPreparedCapabilityStorePackage(prepared);
    const result = await projectPresentation(source.kind, privateSource.packageRoot, source.version);
    let registry;
    try { registry = source.kind === 'plugin' ? await readCanvasPluginStoreRegistry() : await readCanvasSkillStoreRegistry(); }
    catch { throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The configured Store is unavailable.', 503); }
    const offers = 'plugins' in registry ? registry.plugins : registry.skills;
    const version = offers.find(offer => offer.name === source.entryKey)?.versions[source.version];
    if (registry.id !== source.registryId || capabilityStoreRegistryIdentity(registry.registryUrl) !== privateSource.registryIdentity
      || version?.checksum !== source.checksum || result.name !== source.entryKey || result.version !== source.version) throw changed();
    if (version.minCanvasVersion) result.minCanvasVersion = boundedText(version.minCanvasVersion, 200);
    await assertPreparedCapabilityStorePackage(prepared, {...source, resourceId});
    await assertActor(actor);
    return enforceBounds({...result, origin: 'store', source, readOnly: true});
  } finally { await disposePreparedCapabilityStorePackage(prepared); }
}

export async function inspectCapabilityPackagePresentationAction(actorInput: CapabilityResourceActor, reference: string): Promise<CapabilityPackagePresentation> {
  const actor = actorSnapshot(actorInput), resourceRef = capabilityPackageReferenceSchema.parse(reference);
  const source = await resolveCapabilityPackageArtifact(actor, resourceRef);
  const parentBinding = parentStorage(source);
  const containing = parentBinding ? await resolveCapabilityPackageArtifact(actor, source.sourceStamp.parentResourceRef || parentBinding.resourceId) : undefined;
  if (containing && (containing.storage.resourceId !== parentBinding?.resourceId || containing.storage.resourceType !== 'plugin'
    || containing.candidate.ref.revision !== source.candidates.find(candidate => candidate.ref.resourceId === parentBinding?.resourceId)?.ref.revision)) throw changed();
  await assertCapabilityPackageArtifactCurrent(actor, source);
  const result = await withAuthorizedCapabilityPackageResource(actor, source.storage, 'read', {
    expectedMetadataRevision: source.descriptor.metadata.metadataRevision, expectedGrantsRevision: source.descriptor.metadata.grantsRevision,
  }, async authorization => {
    let parentContext: ParentPresentationContext | undefined;
    if (containing) parentContext = await withCapturedPresentation(containing, async root => {
      const validated = await validateCanvasPluginPackage(root);
      if (!validated.valid || !validated.manifest) throw invalid();
      const parsed = await parsePluginSkillsFromManifest(validated.manifest, root, validated.skillsDir);
      if (parsed.errors.length || !parsed.skills.some(skill => skill.name === source.storage.name)) throw invalid();
      return {name: validated.manifest.name, connectors: validated.manifest.connectors?.mcp ?? [], connectorManifest: validated.manifest.connectors, skillNames: parsed.skills.map(skill => skill.name)};
    });
    const projected = await withCapturedPresentation(source, root => projectPresentation(source.storage.resourceType, root, source.sourceStamp.version, parentContext));
    if (containing && (await readExactPackageInventory(containing.packageRoot)).checksum !== containing.sourceStamp.checksum) throw changed();
    if (projected.name !== source.storage.name || (await readExactPackageInventory(source.packageRoot)).checksum !== source.sourceStamp.checksum) throw changed();
    return enforceBounds({...projected, resourceRef: authorization.record.metadata.resourceRef, readOnly: source.readOnly});
  }, {parentStorage: parentBinding});
  if (containing) await assertCapabilityPackageArtifactCurrent(actor, containing);
  await assertCapabilityPackageArtifactCurrent(actor, source);
  return result;
}
