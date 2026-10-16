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
import { isValidAgentSkillName, loadCanvasSkillInterface, parseSkillFile, validateStandaloneSkillWorkflow, type CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
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
  capabilityPackageIconQuerySchema, capabilityPackageMcpTemplateQuerySchema, type CapabilityPackageMcpTemplate,
  type CapabilityPackagePresentation, type CapabilityPackagePresentationDeclaration } from './presentation-contracts';
import { readPluginMcpTemplateFile } from '@/app/lib/plugins/plugin-mcp-template-service';
import { projectCapabilityPackageMcpTemplateConfig } from './mcp-template-projection';
import { installedPluginExtensionIcon, publicPluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import { readFirstDeclaredCapabilityPackageImage, type CapabilityPackageDeclaredIcon } from './package-icon-image';

const changed = () => new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The package source changed. Inspect it again.', 409);
const invalid = () => new CapabilityPackageError('PACKAGE_INVALID', 'The package presentation is unavailable.', 400);
const boundedText = (value: string | undefined, max: number): string | undefined => value
  ? Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '').trim()).slice(0, max).join('') || undefined : undefined;
const envKey = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;

/** Metadata projection for a currently held private draft, without an installed-source identity. */
export async function projectCapabilityPackageDraftContents(kind: 'plugin' | 'skill', root: string) {
  const projected = await projectPresentation(kind, root, '', undefined, { verifiedStoreStaging: true });
  return { title: projected.title, description: projected.description, version: projected.version,
    contents: { children: projected.children, capabilities: projected.capabilities, requirements: projected.requirements,
      scripts: projected.scripts, compatibility: projected.compatibility, requiredEnv: projected.requiredEnv } };
}

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
async function projectPresentation(kind: 'plugin' | 'skill', root: string, fallbackVersion: string, parent?: ParentPresentationContext,
  options: {verifiedStoreStaging?: true} = {}): Promise<CapabilityPackagePresentation> {
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
      required: connector.required === true, recommended: connector.recommended === true, selector: {source: 'mcp', connector: connector.name}});
    for (const connector of normalizeComposioConnectors(connectors)) result.requirements.push({declaredBy, source: 'composio',
      label: boundedText(connector.label || connector.toolkit, limits.title) || 'Composio', required: connector.required === true, recommended: connector.recommended === true,
      selector: {source: 'composio', toolkit: connector.toolkit}});
    for (const connector of normalizeEmailConnectors(connectors)) result.requirements.push({declaredBy, source: 'canvas-email',
      label: boundedText(connector.label, limits.title) || 'Canvas Email', required: connector.required === true, recommended: connector.recommended === true});
  };
  const workflow = (declaredBy: CapabilityPackagePresentationDeclaration, manifest: GenericWorkflowManifestV1 | undefined,
    connectors: readonly {name: string; label?: string}[]) => {
    for (const capability of manifest?.integrationCapabilities ?? []) result.capabilities.push({declaredBy, id: capability.id,
      application: capability.application, required: capability.required,
      alternatives: capability.alternatives.map(alternative => ({source: alternative.source, label: boundedText(alternative.source === 'mcp'
        ? connectors.find(connector => connector.name === alternative.connector)?.label || alternative.connector : alternative.toolkit, limits.title) || alternative.source,
        selector: alternative.source === 'mcp' ? {source: 'mcp', connector: alternative.connector} : {source: 'composio', toolkit: alternative.toolkit}}))});
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
    const pluginIconKey = JSON.stringify(['plugin', manifest.name, manifest.version]);
    result.icon = publicPluginExtensionIcon(manifest.interface?.logo, pluginIconKey)
      || publicPluginExtensionIcon(manifest.interface?.icon, pluginIconKey);
    const license = boundedText(manifest.license, limits.license); if (license) result.license = license;
    const by = {kind, name: manifest.name};
    legacy(by, manifest.connectors); workflow(by, manifest.workflow, manifest.connectors?.mcp ?? []);
    for (const skill of parsed.skills) {
      result.children.push({name: skill.name, title: boundedText(skill.title || skill.name, limits.title) || skill.name,
        description: boundedText(skill.description, limits.description) || '', ...(skill.version ? {version: skill.version} : {}),
        icon: publicPluginExtensionIcon(skill.interface?.iconSmall, JSON.stringify(['plugin', manifest.name, manifest.version, 'skill', skill.name]))
          || publicPluginExtensionIcon(skill.interface?.iconLarge, JSON.stringify(['plugin', manifest.name, manifest.version, 'skill', skill.name]))});
      await skillDetails(skill, manifest.connectors?.mcp ?? [], false);
      enforceBounds(result);
    }
  } else {
    // Verified Store archives use the canonical temporary folder "package";
    // preparation and the final offering check independently enforce their exact name/version.
    const skill = await parseSkillFile(path.join(root, 'SKILL.md'), {validateDirectoryName: !options.verifiedStoreStaging});
    if (!skill) throw invalid();
    result.name = skill.name; result.version = skill.version || fallbackVersion;
    result.title = boundedText(skill.title || skill.name, limits.title) || skill.name;
    result.description = boundedText(skill.description, limits.description) || '';
    const skillIconKey = JSON.stringify(['skill', skill.name, result.version]);
    result.icon = publicPluginExtensionIcon(skill.interface?.iconSmall, skillIconKey)
      || publicPluginExtensionIcon(skill.interface?.iconLarge, skillIconKey);
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
    const result = await projectPresentation(source.kind, privateSource.packageRoot, source.version, undefined, {verifiedStoreStaging: true});
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
    return enforceBounds({...projected, resourceRef: authorization.record.metadata.resourceRef, readOnly: source.readOnly,
      icon: installedPluginExtensionIcon(authorization.record.metadata.resourceRef, source.descriptor.artifact.revision, actor.workspaceId),
      children: projected.children.map(child => ({...child, icon: installedPluginExtensionIcon(authorization.record.metadata.resourceRef,
        source.descriptor.artifact.revision, actor.workspaceId, child.name)})),
      sourceStamp: {checksum: source.sourceStamp.checksum, artifactRevision: source.sourceStamp.artifactRevision,
        ...(containing ? {parent: {resourceRef: containing.descriptor.metadata.resourceRef, checksum: containing.sourceStamp.checksum,
          artifactRevision: containing.sourceStamp.artifactRevision}} : {})}});
  }, {parentStorage: parentBinding});
  if (containing) await assertCapabilityPackageArtifactCurrent(actor, containing);
  await assertCapabilityPackageArtifactCurrent(actor, source);
  return result;
}

/** Only an exact currently readable declaration selects image bytes; browser input never supplies a path. */
export async function readCapabilityPackageIconAction(actorInput: CapabilityResourceActor, reference: string,
  input: unknown): Promise<CapabilityPackageDeclaredIcon | null> {
  const actor = actorSnapshot(actorInput), resourceRef = capabilityPackageReferenceSchema.parse(reference);
  const query = capabilityPackageIconQuerySchema.parse(structuredClone(input));
  await assertActor(actor);
  const requested = await resolveCapabilityPackageArtifact(actor, resourceRef);
  if (query.revision !== undefined && query.revision !== requested.descriptor.artifact.revision) throw changed();
  let source = requested;
  if (query.childName !== undefined) {
    if (requested.storage.resourceType !== 'plugin' || !isValidAgentSkillName(query.childName)) {
      throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The declared skill was not found.', 404);
    }
    const declared = await withCapturedPresentation(requested, async root => {
      const validated = await validateCanvasPluginPackage(root);
      if (!validated.valid || !validated.manifest) throw invalid();
      const parsed = await parsePluginSkillsFromManifest(validated.manifest, root, validated.skillsDir);
      if (parsed.errors.length) throw invalid();
      return parsed.skills.filter(skill => skill.name === query.childName).length === 1;
    });
    const candidates = requested.candidates.filter(candidate => candidate.ref.resourceType === 'skill'
      && candidate.ref.sourceType === 'plugin' && candidate.ref.sourcePluginId === requested.storage.resourceId
      && candidate.ref.name === query.childName);
    if (!declared || candidates.length !== 1 || !candidates[0].resourceMetadata?.resourceRef) {
      throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The declared skill was not found.', 404);
    }
    source = await resolveCapabilityPackageArtifact(actor, candidates[0].resourceMetadata.resourceRef);
    if (source.storage.name !== query.childName || source.storage.sourcePluginId !== requested.storage.resourceId) throw changed();
  }
  const parentBinding = parentStorage(source);
  const containing = parentBinding ? requested.storage.resourceType === 'plugin' && source !== requested
    ? requested : await resolveCapabilityPackageArtifact(actor, source.sourceStamp.parentResourceRef || parentBinding.resourceId) : undefined;
  if (containing && (containing.storage.resourceId !== parentBinding?.resourceId || containing.storage.resourceType !== 'plugin'
    || containing.candidate.ref.revision !== source.candidates.find(candidate => candidate.ref.resourceId === parentBinding?.resourceId)?.ref.revision)) throw changed();
  await assertCapabilityPackageArtifactCurrent(actor, requested);
  if (containing) await assertCapabilityPackageArtifactCurrent(actor, containing);
  await assertCapabilityPackageArtifactCurrent(actor, source);
  const result = await withAuthorizedCapabilityPackageResource(actor, source.storage, 'read', {
    expectedMetadataRevision: source.descriptor.metadata.metadataRevision, expectedGrantsRevision: source.descriptor.metadata.grantsRevision,
  }, async () => withCapturedPresentation(source, async root => {
    if (source.storage.resourceType === 'plugin') {
      const validated = await validateCanvasPluginPackage(root);
      if (!validated.valid || !validated.manifest || validated.manifest.name !== source.storage.name) throw invalid();
      return readFirstDeclaredCapabilityPackageImage(root, [validated.manifest.interface?.logo, validated.manifest.interface?.icon]);
    }
    const skill = await parseSkillFile(path.join(root, 'SKILL.md'));
    if (!skill || skill.name !== source.storage.name) throw invalid();
    const iface = await loadCanvasSkillInterface(root);
    return readFirstDeclaredCapabilityPackageImage(root, [iface?.iconSmall, iface?.iconLarge]);
  }), {parentStorage: parentBinding});
  if (containing) await assertCapabilityPackageArtifactCurrent(actor, containing);
  await assertCapabilityPackageArtifactCurrent(actor, source);
  await assertCapabilityPackageArtifactCurrent(actor, requested);
  return result;
}

/** Read a declared setup template from the exact currently readable package; this creates no connection. */
export async function inspectCapabilityPackageMcpTemplateAction(actorInput: CapabilityResourceActor, reference: string,
  input: unknown): Promise<CapabilityPackageMcpTemplate> {
  const actor = actorSnapshot(actorInput), resourceRef = capabilityPackageReferenceSchema.parse(reference);
  const query = capabilityPackageMcpTemplateQuerySchema.parse(structuredClone(input));
  const source = await resolveCapabilityPackageArtifact(actor, resourceRef);
  if (query.expectedChecksum !== undefined && query.expectedChecksum !== source.sourceStamp.checksum) throw changed();
  const parentBinding = parentStorage(source);
  const containing = parentBinding ? await resolveCapabilityPackageArtifact(actor, source.sourceStamp.parentResourceRef || parentBinding.resourceId) : undefined;
  if (containing && (containing.storage.resourceId !== parentBinding?.resourceId || containing.storage.resourceType !== 'plugin'
    || containing.candidate.ref.revision !== source.candidates.find(candidate => candidate.ref.resourceId === parentBinding?.resourceId)?.ref.revision)) throw changed();
  const templateSource = containing || source;
  await assertCapabilityPackageArtifactCurrent(actor, source);
  if (containing) await assertCapabilityPackageArtifactCurrent(actor, containing);
  const result = await withAuthorizedCapabilityPackageResource(actor, source.storage, 'read', {
    expectedMetadataRevision: source.descriptor.metadata.metadataRevision, expectedGrantsRevision: source.descriptor.metadata.grantsRevision,
  }, async authorization => {
    const projected = await withCapturedPresentation(templateSource, async root => {
      let connectors: CanvasPluginMcpConnector[], declaredBy: CapabilityPackagePresentationDeclaration;
      if (templateSource.storage.resourceType === 'plugin') {
        const validated = await validateCanvasPluginPackage(root);
        if (!validated.valid || !validated.manifest) throw invalid();
        if (containing) {
          const parsed = await parsePluginSkillsFromManifest(validated.manifest, root, validated.skillsDir);
          if (parsed.errors.length || !parsed.skills.some(skill => skill.name === source.storage.name)) throw invalid();
        }
        connectors = normalizeMcpConnectors(validated.manifest.connectors);
        declaredBy = {kind: 'plugin', name: validated.manifest.name};
      } else {
        const skill = await parseSkillFile(path.join(root, 'SKILL.md'));
        if (!skill) throw invalid();
        await validateStandaloneSkillWorkflow(skill);
        connectors = (skill.workflow as SkillWorkflowManifestV1 | undefined)?.mcpConnectors?.map(connector => ({...connector,
          env: connector.env ? [...connector.env] : undefined})) ?? [];
        declaredBy = {kind: 'skill', name: skill.name};
      }
      const matching = connectors.filter(connector => connector.name === query.connector);
      if (matching.length !== 1) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The declared MCP template was not found.', 404);
      const connector = matching[0];
      let defaults: Pick<CapabilityPackageMcpTemplate, 'config' | 'redactedFields'> = {redactedFields: []};
      if (connector.configPath) {
        let template;
        try { template = await readPluginMcpTemplateFile({rootDir: root, configPath: connector.configPath}); }
        catch { throw new CapabilityPackageError('PACKAGE_INVALID', 'The declared MCP template is unavailable.', 400); }
        if (!template.config) throw new CapabilityPackageError('PACKAGE_INVALID', 'The declared MCP template is invalid.', 400);
        defaults = projectCapabilityPackageMcpTemplateConfig(template.config, connector.name);
      }
      return {declaredBy, connector: {name: connector.name,
        ...(connector.label ? {label: boundedText(connector.label, limits.title)} : {}),
        ...(connector.env ? {env: connector.env.filter(key => envKey.test(key))} : {}),
        ...(connector.oauth ? {oauth: true} : {})}, ...defaults};
    });
    if ((await readExactPackageInventory(templateSource.packageRoot)).checksum !== templateSource.sourceStamp.checksum) throw changed();
    return {resourceRef: authorization.record.metadata.resourceRef,
      source: {resourceRef: templateSource.descriptor.metadata.resourceRef, version: templateSource.sourceStamp.version,
        checksum: templateSource.sourceStamp.checksum, artifactRevision: templateSource.sourceStamp.artifactRevision}, ...projected};
  }, {parentStorage: parentBinding});
  if (containing) await assertCapabilityPackageArtifactCurrent(actor, containing);
  await assertCapabilityPackageArtifactCurrent(actor, source);
  return result;
}
