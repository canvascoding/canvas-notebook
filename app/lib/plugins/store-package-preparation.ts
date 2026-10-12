import 'server-only';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SqlConnection } from '@/app/lib/db';
import type { CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { CAPABILITY_PACKAGE_LIMITS, CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { readExactPackageInventory, normalizeCapabilityPackageRelativePath } from '@/app/lib/capabilities/packages/io';
import { validateCapabilityPackage } from '@/app/lib/capabilities/packages/artifacts';
import { rebaseIssuedCapabilityStoreOrigin } from '@/app/lib/capabilities/packages/store-origin';
import type { CapabilityPackageStoreSelection } from '@/app/lib/capabilities/packages/store-contracts';
import { issuePreparedCapabilityStorePackage, type PreparedCapabilityStorePackage } from '@/app/lib/capabilities/packages/store-source';
import { validateCanvasPluginPackage } from './canvas-plugin-manifest';
import { prepareCanvasPluginStoreArchive } from './canvas-plugin-store';
import { prepareCanvasSkillStoreArchive } from '@/app/lib/skills/canvas-skill-store';
import { prepareStoreSeedSource, getPreparedStoreSeedInventory, assertPreparedStoreSeedSource, type PreparedStoreSeedSource } from './store-seed-source';

export type VerifiedCanvasStorePreparationInput = CapabilityPackageStoreSelection & {
  resourceId: string;
  actor?: CapabilityResourceActor;
  expectedOrigin?: {registryIdentity: string; version: string; upstreamChecksum: string};
};
const changed = () => new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The prepared Store source changed. Reload the Store.', 409);
const denied = () => new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A referenced skill source is unavailable.', 403);


async function bundleReadableSeeds(packageRoot: string, actor: CapabilityResourceActor | undefined): Promise<PreparedStoreSeedSource[]> {
  const validation = await validateCanvasPluginPackage(packageRoot);
  if (!validation.valid || !validation.manifest) throw changed();
  const references = validation.manifest.skillRefs ?? [];
  if (!references.length) return [];
  if (!actor) throw denied();
  const prefix = normalizeCapabilityPackageRelativePath((validation.manifest.skills || 'skills').replace(/^\.\//u, ''));
  const initial = await readExactPackageInventory(packageRoot);
  let totalBytes = initial.totalBytes, fileCount = initial.files.length;
  const dependencies: PreparedStoreSeedSource[] = [];
  const targets = new Set<string>();
  for (const reference of [...references].sort((a, b) => a.name.localeCompare(b.name))) {
    if (reference.source && reference.source !== 'seed') throw denied();
    const relativeRoot = normalizeCapabilityPackageRelativePath(`${prefix}/${reference.name}`);
    const folded = relativeRoot.normalize('NFC').toLowerCase();
    if (targets.has(folded) || await fs.lstat(path.join(packageRoot, relativeRoot)).then(() => true, () => false)) throw changed();
    targets.add(folded);
    const dependency = await prepareStoreSeedSource(actor, reference.name, {maxFiles: CAPABILITY_PACKAGE_LIMITS.maxFiles - fileCount,
      maxTotalBytes: CAPABILITY_PACKAGE_LIMITS.maxTotalBytes - totalBytes});
    const inventory = getPreparedStoreSeedInventory(dependency);
    await assertPreparedStoreSeedSource(dependency);
    for (const directory of inventory.directories) await fs.mkdir(path.join(packageRoot, relativeRoot,
      normalizeCapabilityPackageRelativePath(directory)), {recursive: true});
    for (const file of inventory.files) {
      const target = path.join(packageRoot, normalizeCapabilityPackageRelativePath(`${relativeRoot}/${file.relativePath}`));
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.writeFile(target, file.bytes, {flag: 'wx', mode: file.executable ? 0o700 : 0o600});
    }
    totalBytes += inventory.totalBytes; fileCount += inventory.files.length;
    dependencies.push(dependency);
  }
  const manifestPath = path.join(packageRoot, '.canvas-plugin', 'plugin.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.skills = `./${prefix}`;
  for (const key of ['skillRefs', 'skill_refs', 'seedSkills', 'seed_skills']) delete manifest[key];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await readExactPackageInventory(packageRoot);
  return dependencies;
}

async function ownCleanup(tempRoot: string, packageRoot: string): Promise<() => Promise<void>> {
  const parent = await fs.realpath(os.tmpdir());
  const canonical = await fs.realpath(tempRoot), observed = await fs.lstat(canonical, {bigint: true});
  if (path.dirname(canonical) !== parent || !/^canvas-(?:plugin|skill)-store-[A-Za-z0-9]+$/u.test(path.basename(canonical))
    || !observed.isDirectory() || observed.isSymbolicLink() || await fs.realpath(packageRoot) !== path.join(canonical, 'package')) throw changed();
  return async () => {
    const current = await fs.lstat(canonical, {bigint: true}).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
    });
    if (!current) return;
    if (current.ino !== observed.ino || current.dev !== observed.dev || !current.isDirectory() || current.isSymbolicLink()) throw changed();
    await fs.rm(canonical, {recursive: true, force: true});
  };
}

async function prepare(input: VerifiedCanvasStorePreparationInput, kind: 'plugin' | 'skill'): Promise<PreparedCapabilityStorePackage> {
  if (input.kind !== kind) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The Store package kind is invalid.', 400);
  const actor = input.actor ? Object.freeze({...input.actor}) : undefined;
  const intake = kind === 'plugin' ? await prepareCanvasPluginStoreArchive(input) : await prepareCanvasSkillStoreArchive(input);
  let cleanup: (() => Promise<void>) | undefined;
  try {
    cleanup = await ownCleanup(intake.tempRoot, intake.packageRoot);
    const dependencies = kind === 'plugin' ? await bundleReadableSeeds(intake.packageRoot, actor) : [];
    const validation = await validateCapabilityPackage(kind, intake.packageRoot, {name: input.entryKey, version: input.version});
    if (!validation.valid || !validation.checksum) throw new CapabilityPackageError('PACKAGE_INVALID', 'The complete Store package is invalid.', 400);
    const origin = dependencies.length ? await rebaseIssuedCapabilityStoreOrigin(intake.storeOrigin,
      {resourceId: input.resourceId, packageRoot: intake.packageRoot}) : intake.storeOrigin;
    const verifyCurrent = async (database?: SqlConnection) => {
      await intake.verifyCurrent({verifyRegistry: !database});
      for (const dependency of dependencies) {
        await assertPreparedStoreSeedSource(dependency, database);
      }
    };
    await verifyCurrent();
    return issuePreparedCapabilityStorePackage({kind, resourceId: input.resourceId, registryId: input.registryId,
      registryIdentity: origin.registryIdentity, entryKey: input.entryKey, version: input.version, upstreamChecksum: input.checksum,
      baselineChecksum: validation.checksum, packageRoot: intake.packageRoot, storeOrigin: origin, validation, verifyCurrent, cleanup});
  } catch (error) {
    if (cleanup) await cleanup();
    else {
      // Intake created this random private directory; no caller-controlled path participates here.
      await fs.rm(intake.tempRoot, {recursive: true, force: true});
    }
    throw error;
  }
}

export async function prepareVerifiedCanvasPluginStorePackage(input: VerifiedCanvasStorePreparationInput): Promise<PreparedCapabilityStorePackage> {
  return prepare(input, 'plugin');
}
export async function prepareVerifiedCanvasSkillStorePackage(input: VerifiedCanvasStorePreparationInput): Promise<PreparedCapabilityStorePackage> {
  return prepare(input, 'skill');
}
