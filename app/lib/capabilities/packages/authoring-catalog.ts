import 'server-only';
import path from 'node:path';
import { parsePluginSkillsFromManifest } from '@/app/lib/plugins/canvas-plugin-registry';
import { isValidCanvasPluginVersion, validateCanvasPluginPackage } from '@/app/lib/plugins/canvas-plugin-manifest';
import { validateCreatorPluginManifest, CREATOR_PLUGIN_MANIFEST_MAX_BYTES } from '@/app/lib/plugins/creator-plugin-manifest';
import { searchPluginExtensionAuthoringMetadata } from '@/app/lib/plugins/plugin-extension-authoring-search';
import { parseSkillFile, type CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import type { CapabilityResourceActor } from '../resources/contracts';
import { workflowApplicationSchema } from '../workflow-contracts';
import { withPublishedPackage, readCapabilityPackageDraftAction, readCapabilityPackageDraftFileAction, writeCapabilityPackageDraftFileAction } from './actions';
import { assertCapabilityPackageArtifactCurrent, resolveCapabilityPackageArtifact } from './artifacts';
import { readExactPackageInventory, withCapturedCapabilityPackageInventory } from './io';
import { capabilityPackagePublishedTreeSchema, capabilityPackageReferenceSchema } from './schemas';
import { CapabilityPackageError, isCapabilityPackageError } from './contracts';
import { capabilityPackageRequirementInputSchema, type CapabilityPackageAuthoringRequirement, type CapabilityPackageAuthoringSource } from './authoring-catalog-contracts';

const changed = () => new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The source or draft changed. Reload its current selection.', 409);
const invalid = (message: string) => new CapabilityPackageError('PACKAGE_INVALID', message, 400);
const conflict = () => new CapabilityPackageError('PACKAGE_NAMESPACE_CONFLICT', 'This requirement identity already has a different declaration. Choose another name or edit the existing declaration.', 409);
const clean = (text: string, limit: number) => text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, limit);
const manifestPath = '.canvas-plugin/plugin.json';

/** Exact portable source choices derived from current Read authority and the actual package loader. */
export async function inspectCapabilityPackageAuthoringSourceAction(actor: CapabilityResourceActor, reference: string, value: unknown = {}): Promise<CapabilityPackageAuthoringSource> {
  const query = capabilityPackagePublishedTreeSchema.parse(value);
  const original = await resolveCapabilityPackageArtifact(actor, capabilityPackageReferenceSchema.parse(reference));
  const child = original.storage.resourceType === 'skill' && original.storage.sourceType === 'plugin';
  const parentRef = child ? original.sourceStamp.parentResourceRef : null;
  const childRoot = child ? original.sourceStamp.relativeRoot : undefined;
  if (child && (!parentRef || childRoot == null)) throw invalid('Choose the containing plugin and one bundled skill. External skill references must first be bundled.');
  const sourceRef = parentRef || original.descriptor.metadata.resourceRef;
  const result = await withPublishedPackage(actor, sourceRef, query.revisionRef, async location => {
    const inventory = await readExactPackageInventory(location.rootPath);
    const source = { resourceRef: sourceRef, ...('revisionRef' in location ? { revisionRef: location.revisionRef } : {}), expectedChecksum: inventory.checksum };
    const skills = await withCapturedCapabilityPackageInventory(inventory, async root => {
      let items: CanvasSkill[];
      if (location.kind === 'plugin') {
        const validation = await validateCanvasPluginPackage(root);
        if (!validation.valid || !validation.manifest) throw invalid('Repair the selected plugin manifest before copying skills.');
        const parsed = await parsePluginSkillsFromManifest(validation.manifest, root, validation.skillsDir);
        if (parsed.errors.length) throw invalid('The selected plugin does not declare valid skills.');
        items = parsed.skills;
      } else {
        const skill = await parseSkillFile(path.join(root, 'SKILL.md'), { validateDirectoryName: false });
        if (!skill) throw invalid('The selected standalone skill is invalid.');
        items = [skill];
      }
      const available = new Set(inventory.files.map(file => file.relativePath));
      return items.flatMap(skill => {
        const relativeRoot = path.relative(root, skill.directory).split(path.sep).join('/');
        // Only actual package bytes can be composed. A seed reference is not a bundled child.
        if (!available.has(relativeRoot ? `${relativeRoot}/SKILL.md` : 'SKILL.md')) return [];
        if (child && relativeRoot !== childRoot) return [];
        if (!skill.version || !isValidCanvasPluginVersion(skill.version)) return [];
        return [{ name: skill.name, title: clean(skill.title || skill.name, 200), description: clean(skill.description, 2000), version: skill.version,
          source: { ...source, ...(location.kind === 'plugin' ? { childRelativeRoot: relativeRoot || '.' } : {}) } }];
      });
    });
    if ((await readExactPackageInventory(location.rootPath)).checksum !== inventory.checksum) throw changed();
    return { source, skills };
  });
  await assertCapabilityPackageArtifactCurrent(actor, original);
  return result;
}

/** Adds a portable requirement only; catalogue profiles, backend IDs and account choices never enter the package. */
export async function addCapabilityPackageDraftRequirementAction(actor: CapabilityResourceActor, reference: string, value: unknown) {
  const input = capabilityPackageRequirementInputSchema.parse(structuredClone(value));
  const selectedDraft = await readCapabilityPackageDraftAction(actor, reference);
  if (selectedDraft.draft.kind !== 'plugin') throw invalid('Only a plugin draft can declare package requirements.');
  if (selectedDraft.draft.draftRevision !== input.expectedDraftRevision) throw changed();
  const current = await readCapabilityPackageDraftFileAction(actor, reference, { path: manifestPath, maxBytes: CREATOR_PLUGIN_MANIFEST_MAX_BYTES }).catch(error => {
    if (isCapabilityPackageError(error) && error.code === 'PACKAGE_NOT_FOUND'
      || error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') throw invalid('Create or repair the canonical Creator Plugin manifest before adding requirements.');
    throw error;
  });
  if (current.draft.draftRevision !== input.expectedDraftRevision) throw changed();
  if (!current.file.eof) throw invalid('Repair the canonical plugin manifest before adding requirements.');
  const validation = validateCreatorPluginManifest(Buffer.from(current.file.content, 'base64').toString('utf8'));
  if (!validation.valid || !validation.manifest) throw invalid('Create or repair the canonical Creator Plugin manifest before adding requirements.');
  const catalog = await searchPluginExtensionAuthoringMetadata(actor, { q: '', types: ['integration', 'mcp'], selected: input.catalogId,
    stock: 'all', source: input.catalogId.startsWith('composio:') ? 'composio' : 'mcp', scope: 'all', audience: null, teamId: null, cursor: null, limit: 1 });
  const item = catalog.selectedItem;
  if (!item || item.id !== input.catalogId || !item.access.canRead || item.kind !== 'integration' && item.kind !== 'mcp') {
    throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The selected integration or MCP is unavailable in this workspace.', 404);
  }
  const manifest = validation.manifest, connectors = manifest.connectors ??= {};
  let requirement: CapabilityPackageAuthoringRequirement, unchanged: boolean;
  if (item.kind === 'integration') {
    if (input.connectorName !== undefined) throw invalid('Composio requirements use the exact toolkit slug without an MCP connector name.');
    const toolkit = workflowApplicationSchema.parse(item.toolkit.slug), declaration = { toolkit, required: input.required };
    requirement = { kind: 'integration', ...declaration };
    const existing = connectors.composio?.find(connector => connector.toolkit === toolkit);
    if (existing && (existing.required ?? false) !== declaration.required) throw conflict();
    unchanged = Boolean(existing);
    if (!existing) (connectors.composio ??= []).push(declaration);
  } else {
    if (!input.connectorName) throw invalid('Choose an explicit portable MCP connector name for this package.');
    const declaration = { name: input.connectorName, required: input.required };
    requirement = { kind: 'mcp', ...declaration };
    const existing = connectors.mcp?.find(connector => connector.name === input.connectorName);
    if (existing && (existing.required ?? false) !== declaration.required) throw conflict();
    unchanged = Boolean(existing);
    if (!existing) (connectors.mcp ??= []).push(declaration);
  }
  if (unchanged) {
    const fresh = await readCapabilityPackageDraftFileAction(actor, reference, { path: manifestPath, maxBytes: CREATOR_PLUGIN_MANIFEST_MAX_BYTES });
    if (fresh.draft.draftRevision !== input.expectedDraftRevision || fresh.file.checksum !== current.file.checksum) throw changed();
    return { draft: fresh.draft, changed: false, requirement };
  }
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!validateCreatorPluginManifest(content).valid) throw invalid('The requirement would violate the Creator Plugin manifest contract.');
  const result = await writeCapabilityPackageDraftFileAction(actor, reference, { expectedDraftRevision: input.expectedDraftRevision,
    path: manifestPath, encoding: 'base64', content: Buffer.from(content).toString('base64') });
  return { ...result, changed: true, requirement };
}
