import 'server-only';

import path from 'node:path';
import YAML from 'yaml';
import { parseFrontmatter } from '@/app/lib/skills/canvas-skill-manifest';
import { CapabilityPackageError } from './contracts';
import type { ResolvedCapabilityPackageArtifact } from './artifacts';
import type { ExactCapabilityPackageInventory } from './io';

export type CapturedPackageIconSource = Pick<ResolvedCapabilityPackageArtifact, 'storage' | 'packageRoot' | 'bundledReferences'>
  & { sourceStamp: Pick<ResolvedCapabilityPackageArtifact['sourceStamp'], 'version' | 'dependencies'> };

const invalid = () => new CapabilityPackageError('PACKAGE_INVALID', 'The package image declaration is unavailable.', 400);
const missingChild = () => new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The declared skill was not found.', 404);
const changed = () => new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The captured child image source changed.', 409);
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const capturedText = (inventory: ExactCapabilityPackageInventory, relative: string) => inventory.files.find(file => file.relativePath === relative)?.bytes.toString('utf8');

function manifest(source: CapturedPackageIconSource, inventory: ExactCapabilityPackageInventory): Record<string, unknown> {
  let parsed: Record<string, unknown> | undefined;
  try { parsed = record(JSON.parse(capturedText(inventory, '.canvas-plugin/plugin.json') ?? '')); } catch { throw invalid(); }
  if (!parsed || text(parsed.name) !== source.storage.name || text(parsed.version) !== source.sourceStamp.version) throw invalid();
  return parsed;
}

/** A live declaration read cannot replace the manifest or interface from the captured checksum. */
export function capturedCapabilityPackageIconDeclarations(source: CapturedPackageIconSource,
  inventory: ExactCapabilityPackageInventory): readonly unknown[] {
  if (source.storage.resourceType === 'plugin') {
    const iface = record(manifest(source, inventory).interface);
    return [text(iface?.logo), text(iface?.icon)];
  }
  const rawSkill = capturedText(inventory, 'SKILL.md');
  if (!rawSkill || parseFrontmatter(rawSkill).frontmatter?.name !== source.storage.name) throw invalid();
  const raw = capturedText(inventory, 'agents/canvas.yaml');
  if (!raw) return [];
  try {
    const iface = record(record(YAML.parse(raw))?.interface);
    return [text(iface?.icon_small ?? iface?.iconSmall), text(iface?.icon_large ?? iface?.iconLarge)];
  } catch { return []; }
}

/** Verify actual child membership using the captured parent's declaration and the
 * already authorized exact storage identities, including declared seed references. */
export function assertCapturedCapabilityPackageChild(parent: CapturedPackageIconSource, parentInventory: ExactCapabilityPackageInventory,
  child: CapturedPackageIconSource, childInventory: ExactCapabilityPackageInventory): void {
  if (parent.storage.resourceType !== 'plugin' || child.storage.resourceType !== 'skill'
    || child.storage.sourceType !== 'plugin' || child.storage.sourcePluginId !== parent.storage.resourceId) throw missingChild();
  const rawSkill = capturedText(childInventory, 'SKILL.md');
  if (!rawSkill || parseFrontmatter(rawSkill).frontmatter?.name !== child.storage.name) throw missingChild();
  const declared = manifest(parent, parentInventory);
  const rawReferences = declared.skillRefs ?? declared.skill_refs ?? declared.seedSkills ?? declared.seed_skills;
  const references = (Array.isArray(rawReferences) ? rawReferences : rawReferences === undefined ? [] : [rawReferences])
    .map(value => text(value) ?? text(record(value)?.name)).filter(Boolean);
  const seed = references.includes(child.storage.name) && parent.bundledReferences?.find(reference => reference.source.kind === 'skill' && reference.source.name === child.storage.name
    && path.resolve(reference.source.rootPath) === path.resolve(child.packageRoot));
  if (seed) {
    if (seed.source.resourceRef !== child.storage.resourceId || seed.checksum !== childInventory.checksum
      || !parent.sourceStamp.dependencies?.some(dependency => dependency.resourceId === child.storage.resourceId && dependency.name === child.storage.name
        && dependency.checksum === seed.checksum && dependency.relativeRoot === seed.relativeTargetRoot)) throw changed();
    return;
  }
  const relative = path.relative(parent.packageRoot, child.packageRoot).split(path.sep).join('/');
  const rawSkills = text(declared.skills) ?? (references.length ? undefined : './skills');
  if (rawSkills === undefined || relative.startsWith('../') || path.isAbsolute(relative)) throw missingChild();
  const skillsRoot = path.posix.normalize(rawSkills).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (skillsRoot.startsWith('../') || skillsRoot.startsWith('/') || skillsRoot === '..') throw missingChild();
  const root = skillsRoot === '.' ? '' : skillsRoot;
  const rootSkill = root ? `${root}/SKILL.md` : 'SKILL.md';
  if (parentInventory.files.some(file => file.relativePath === rootSkill)) {
    if (relative !== root) throw missingChild();
  } else {
    const prefix = root ? `${root}/` : '';
    if (!relative.startsWith(prefix) || !relative.slice(prefix.length) || relative.slice(prefix.length).includes('/')) throw missingChild();
  }
  const prefix = relative ? `${relative}/` : '';
  const files = parentInventory.files.filter(file => file.relativePath.startsWith(prefix));
  if (files.length !== childInventory.files.length || files.some(file => {
    const other = childInventory.files.find(childFile => childFile.relativePath === file.relativePath.slice(prefix.length));
    return !other || file.size !== other.size || file.checksum !== other.checksum || !file.bytes.equals(other.bytes);
  })) throw changed();
  const directories = parentInventory.directories.filter(directory => directory.startsWith(prefix) && directory !== relative)
    .map(directory => directory.slice(prefix.length)).sort();
  if (JSON.stringify(directories) !== JSON.stringify([...childInventory.directories].sort())) throw changed();
}
