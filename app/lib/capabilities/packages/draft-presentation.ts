import 'server-only';

import path from 'node:path';
import { z } from 'zod';
import { parseSkillFile } from '@/app/lib/skills/canvas-skill-manifest';
import { validateCanvasPluginPackage } from '@/app/lib/plugins/canvas-plugin-manifest';
import { discoverPluginSkillFiles, isManifestDeclaredPluginRootSkill } from '@/app/lib/plugins/canvas-plugin-registry';
import type { CapabilityResourceActor } from '../resources/contracts';
import { CapabilityPackageError, isCapabilityPackageError, type CapabilityPackageDraft } from './contracts';
import { capabilityPackageDraftReferenceSchema } from './schemas';
import { withCapabilityPackageDraftRead } from './store';
import { readCapabilityPackageDraftCaptures, type CapabilityPackageSourceCapture } from './source-captures';
import { readExactPackageInventory, resolveCapabilityPackageDraftLocation } from './io';
import { projectCapabilityPackageDraftContents } from './presentation-actions';
import { readDeclaredCapabilityPackageImage, type CapabilityPackageIconImage } from './package-icon-image';
import type { CapabilityPackageDraftCaptureSummary, CapabilityPackageDraftPresentation } from './draft-presentation-contracts';

export const capabilityPackageDraftPresentationQuerySchema = z.object({ expectedDraftRevision: z.coerce.number().int().positive().optional() }).strict();
const maxSkills = 64;
const maxCaptures = 64;
const unavailable = () => new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The draft changed. Reload its current preview.', 409);
const text = (value: string | undefined, max: number) => value?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, max) || '';

function captureSummary(capture: CapabilityPackageSourceCapture): CapabilityPackageDraftCaptureSummary {
  const known: Record<string, CapabilityPackageDraftCaptureSummary['adjustmentsAtCapture'][number]> = {
    'Renamed the copied skill.': 'name', 'Renamed the imported package for its separately managed target.': 'name',
    'Moved standalone MCP connector declarations to the parent plugin.': 'mcp',
    'Remapped copied workflow skill references.': 'skill_references',
    'Adjusted a copied skill image reference.': 'image', 'Adjusted a package-local Markdown link.': 'markdown',
  };
  return { source: capture.source, sourceName: text(capture.source === 'package' ? capture.name : capture.packageName, 200),
    sourceVersion: text(capture.version, 200), targetName: text(capture.targetName, 200),
    targetVersionAtCapture: text(capture.targetVersion, 200), versionChangedAtCapture: capture.version !== capture.targetVersion,
    adjustmentsAtCapture: [...new Set(capture.changes.map(change => known[change] ?? 'other'))],
    ...(capture.source === 'package' && capture.parentName ? { parent: { name: text(capture.parentName, 200), version: text(capture.parentVersion, 200) } } : {}) };
}

function expectedRevision(draft: CapabilityPackageDraft, value: unknown) {
  const input = capabilityPackageDraftPresentationQuerySchema.parse(value);
  if (input.expectedDraftRevision !== undefined && input.expectedDraftRevision !== draft.draftRevision) throw unavailable();
}

/** Reuses the existing passive image boundary; no absolute or caller-chosen image path is accepted. */
async function draftImage(root: string, kind: 'plugin' | 'skill'): Promise<CapabilityPackageIconImage | null> {
  if (kind === 'plugin') {
    const parsed = await validateCanvasPluginPackage(root);
    return parsed.manifest ? await readDeclaredCapabilityPackageImage(root, parsed.manifest.interface?.logo)
      ?? await readDeclaredCapabilityPackageImage(root, parsed.manifest.interface?.icon) : null;
  }
  const skill = await parseSkillFile(path.join(root, 'SKILL.md'), { validateDirectoryName: false });
  return skill ? await readDeclaredCapabilityPackageImage(root, skill.interface?.iconSmall)
    ?? await readDeclaredCapabilityPackageImage(root, skill.interface?.iconLarge) : null;
}

export async function inspectCapabilityPackageDraftPresentationAction(actor: CapabilityResourceActor, reference: string,
  value: unknown = {}): Promise<CapabilityPackageDraftPresentation> {
  return withCapabilityPackageDraftRead(actor, capabilityPackageDraftReferenceSchema.parse(reference), async (record, database) => {
    expectedRevision(record.draft, value);
    const captures = await readCapabilityPackageDraftCaptures(actor, record.draft.draftRef, database);
    const location = resolveCapabilityPackageDraftLocation({ ...record.draft, owner: record.targetOwnership });
    const inventory = await readExactPackageInventory(location.rootPath);
    const result: CapabilityPackageDraftPresentation = { schemaVersion: 1, origin: 'draft', draftRef: record.draft.draftRef,
      draftRevision: record.draft.draftRevision, checksum: inventory.checksum, kind: record.draft.kind, name: record.draft.name,
      title: record.draft.name, description: '', version: null, ownership: record.targetOwnership,
      authoring: { operation: record.draft.operation, intendedAudience: 'not_specified',
        captures: captures.slice(0, maxCaptures).map(captureSummary), capturesTruncated: captures.length > maxCaptures },
      presentation: null, previewIncomplete: true, imageAvailable: false, skills: [], skillsTruncated: false };
    try {
      const projected = await projectCapabilityPackageDraftContents(record.draft.kind, location.rootPath);
      result.title = projected.title; result.description = projected.description; result.version = projected.version;
      result.presentation = projected.contents; result.previewIncomplete = false;
    } catch (error) {
      if (!isCapabilityPackageError(error) || !['PACKAGE_INVALID', 'PACKAGE_PATH_INVALID'].includes(error.code)) throw error;
    }
    const inventoryPaths = new Set(inventory.files.map(file => file.relativePath));
    let candidates = inventoryPaths.has('SKILL.md') && record.draft.kind === 'skill'
      ? [{ relativePath: 'SKILL.md', validateDirectoryName: false }] : [];
    if (record.draft.kind === 'plugin') {
      const parsed = await validateCanvasPluginPackage(location.rootPath);
      if (parsed.manifest) {
        result.title = text(parsed.manifest.interface?.displayName || parsed.manifest.name, 200);
        result.description = text(parsed.manifest.description, 2000); result.version = text(parsed.manifest.version, 200) || null;
      }
      const skillFiles = parsed.skillsDir ? await discoverPluginSkillFiles(parsed.skillsDir) : [];
      candidates = skillFiles.map(skillPath => {
        const relativePath = path.relative(location.rootPath, skillPath).split(path.sep).join('/');
        if (!inventoryPaths.has(relativePath)) throw unavailable();
        return { relativePath, validateDirectoryName: !isManifestDeclaredPluginRootSkill({ installDir: location.rootPath, skillsDir: parsed.skillsDir }, skillPath) };
      });
    }
    result.skillsTruncated = candidates.length > maxSkills;
    for (const file of candidates.slice(0, maxSkills)) {
      const skill = await parseSkillFile(path.join(location.rootPath, ...file.relativePath.split('/')), { validateDirectoryName: file.validateDirectoryName });
      if (!skill) { result.previewIncomplete = true; continue; }
      const relativeRoot = path.posix.dirname(file.relativePath);
      const captured = captures.some(capture => (capture.targetRelativeRoot || '.') === relativeRoot
        && (capture.source === 'package' || capture.kind === 'skill'));
      result.skills.push({ name: skill.name, title: text(skill.title || skill.name, 200), description: text(skill.description, 2000),
        version: skill.version ?? null, path: file.relativePath, origin: captured ? 'captured' : 'not_recorded' });
    }
    result.imageAvailable = Boolean(await draftImage(location.rootPath, record.draft.kind));
    if ((await readExactPackageInventory(location.rootPath)).checksum !== inventory.checksum) throw unavailable();
    return result;
  });
}

export async function readCapabilityPackageDraftImageAction(actor: CapabilityResourceActor, reference: string,
  value: { expectedDraftRevision: number }): Promise<CapabilityPackageIconImage> {
  const query = capabilityPackageDraftPresentationQuerySchema.required().parse(value);
  return withCapabilityPackageDraftRead(actor, capabilityPackageDraftReferenceSchema.parse(reference), async record => {
    expectedRevision(record.draft, query);
    const location = resolveCapabilityPackageDraftLocation({ ...record.draft, owner: record.targetOwnership });
    const inventory = await readExactPackageInventory(location.rootPath);
    const image = await draftImage(location.rootPath, record.draft.kind);
    if (!image) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The draft image is not available yet.', 404);
    if ((await readExactPackageInventory(location.rootPath)).checksum !== inventory.checksum) throw unavailable();
    return image;
  });
}
