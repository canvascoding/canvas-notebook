import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SqlConnection } from '@/app/lib/db';
import type { CapabilityResourceActor, CapabilityResourceStorageBinding } from '@/app/lib/capabilities/resources/contracts';
import { CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { readExactPackageInventory, normalizeCapabilityPackageRelativePath, type ExactCapabilityPackageInventory } from '@/app/lib/capabilities/packages/io';
import { withAuthorizedCapabilityPackageResource } from '@/app/lib/capabilities/resources/store';
import { createCapabilityResourceId } from '@/app/lib/capabilities/reference';
import { isValidAgentSkillName, parseSkillFile } from '@/app/lib/skills/canvas-skill-manifest';

/** Repository-distributed sources only. This receipt does not register or activate a runtime skill. */
export type PreparedStoreSeedSource = Readonly<{name: string; version: string | null; checksum: string}>;
type Source = {actor: CapabilityResourceActor; storage: CapabilityResourceStorageBinding; root: string; inventory: ExactCapabilityPackageInventory};
const key = Symbol.for('canvas.store.seed-source.v1');
const globals = globalThis as typeof globalThis & {[key]?: WeakMap<object, Source>};
const sources = globals[key] ??= new WeakMap<object, Source>();
const denied = () => new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A referenced bundled skill is unavailable.', 403);

/** Parse only captured, no-follow bytes. The existing parser never touches the original source tree. */
async function parseCapturedSeed(name: string, inventory: ExactCapabilityPackageInventory): Promise<string | null> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-store-seed-check-'));
  const observation = await fs.lstat(temporary, {bigint: true});
  const root = path.join(temporary, name);
  try {
    await fs.mkdir(root);
    for (const directory of inventory.directories) await fs.mkdir(path.join(root, normalizeCapabilityPackageRelativePath(directory)), {recursive: true});
    for (const file of inventory.files) {
      const target = path.join(root, normalizeCapabilityPackageRelativePath(file.relativePath));
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.writeFile(target, file.bytes, {flag: 'wx', mode: file.executable ? 0o700 : 0o600});
    }
    const skill = await parseSkillFile(path.join(root, 'SKILL.md'));
    if (!skill || skill.name !== name) throw denied();
    return skill.version || null;
  } finally {
    const current = await fs.lstat(temporary, {bigint: true});
    if (current.ino !== observation.ino || current.dev !== observation.dev || !current.isDirectory() || current.isSymbolicLink()) throw denied();
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

/** Called only for an exact seed reference from a validated configured Store manifest. */
export async function prepareStoreSeedSource(actorInput: CapabilityResourceActor, name: string,
  budget: {maxFiles: number; maxTotalBytes: number}): Promise<PreparedStoreSeedSource> {
  if (!isValidAgentSkillName(name)) throw denied();
  const seedParent = path.join(process.cwd(), 'seed_skills');
  const entry = (await fs.readdir(seedParent, {withFileTypes: true})).find(candidate => candidate.name === name);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) throw denied();
  const root = path.join(seedParent, name);
  const actor = Object.freeze({...actorInput});
  const storage: CapabilityResourceStorageBinding = Object.freeze({resourceType: 'skill', scopeType: 'system', sourceType: 'core',
    resourceId: createCapabilityResourceId({resourceType: 'skill', scopeType: 'system', sourceType: 'core', name}), name,
    sourcePluginId: null, organizationId: null, ownerUserId: null});
  const captured = await withAuthorizedCapabilityPackageResource(actor, storage, 'read', undefined, async () => {
    const inventory = await readExactPackageInventory(root, budget);
    const version = await parseCapturedSeed(name, inventory);
    return {inventory, version};
  });
  const {inventory, version} = captured;
  const receipt = Object.freeze({name, version, checksum: inventory.checksum});
  sources.set(receipt, {actor, storage, root, inventory});
  return receipt;
}

export function getPreparedStoreSeedInventory(receipt: PreparedStoreSeedSource): ExactCapabilityPackageInventory {
  const source = sources.get(receipt); if (!source) throw denied();
  return {...source.inventory, files: source.inventory.files.map(file => ({...file, bytes: Buffer.from(file.bytes)})),
    directories: [...source.inventory.directories]};
}

export async function assertPreparedStoreSeedSource(receipt: PreparedStoreSeedSource, database?: SqlConnection): Promise<void> {
  const source = sources.get(receipt); if (!source) throw denied();
  await withAuthorizedCapabilityPackageResource(source.actor, source.storage, 'read', undefined, async () => {
    const inventory = await readExactPackageInventory(source.root);
    if (inventory.checksum !== receipt.checksum) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'A referenced bundled skill changed.', 409);
  }, {database});
}
