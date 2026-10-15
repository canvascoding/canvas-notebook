/** Test-only: make one fully receipted own package removable by the original DATA teardown. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { assertDatabaseOwnership, privateBytes, requireOwnedYjsQaTarget, type DatabaseIdentity,
  type OwnedYjsReceipt } from './lib/owned-yjs-authority-qa';
import type { NativeMarkdownSandboxPackageCleanupReceipt } from '../tests/helpers/native-markdown-sandbox-package';
import type { OwnedSandboxChatClosure } from '../tests/helpers/owned-sandbox-agent-chat';

type RecordValue = Record<string, unknown>;
type FileEntry = { path: string; size: number; checksum: string };
export type OwnedYjsSandboxPackageUnsealInput = {
  version: 1; kind: 'owned-yjs-sandbox-package-unseal-v1'; fixtureNonce: string;
  packageReceipt: NativeMarkdownSandboxPackageCleanupReceipt;
  closure: OwnedSandboxChatClosure;
  activation: unknown; personalSelection: unknown;
};

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const maxBytes = 64 * 1024 * 1024;
const maxFileBytes = 4 * 1024 * 1024;
const maxEntries = 4096;
const maxDirectories = 128;

function record(value: unknown): RecordValue {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as RecordValue;
}
function boundedText(value: unknown, maximum = 256): string {
  assert(typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value));
  return value;
}
function component(value: unknown): string {
  const result = boundedText(value);
  assert(!['.', '..'].includes(result) && !result.includes('/') && !result.includes('\\') && result === result.trim());
  return result;
}
function reference(value: unknown, prefix: string): string {
  const matched = boundedText(value).match(new RegExp(`^${prefix}:(${uuid})$`, 'u'));
  assert(matched); return matched[1];
}
function relative(value: unknown): string {
  const result = boundedText(value, 1024);
  assert(!path.isAbsolute(result) && !result.includes('\\'));
  const parts = result.split('/');
  assert(parts.length <= 32 && parts.every(part => part && part !== '.' && part !== '..'));
  return result;
}
function equalStat(left: BigIntStats, right: BigIntStats): void {
  for (const key of ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(left[key], right[key]);
}
function normalizeFiles(value: unknown): FileEntry[] {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 256);
  const files = value.map(item => {
    const entry = record(item), file = { path: relative(entry.path), size: Number(entry.size), checksum: boundedText(entry.checksum, 64) };
    assert(entry.size === file.size && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= maxFileBytes);
    assert.match(file.checksum, /^[a-f0-9]{64}$/u);
    return file;
  }).sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(new Set(files.map(file => file.path)).size, files.length);
  return files;
}
function normalizeDirectories(value: unknown): string[] {
  assert(Array.isArray(value) && value.length <= 256);
  const directories = value.map(relative).sort((left, right) => left.localeCompare(right));
  assert.equal(new Set(directories).size, directories.length); return directories;
}
function successfulData(value: unknown): RecordValue {
  const response = record(value); assert.equal(response.success, true); return record(response.data);
}

/** No product inventory helper: readExactPackageInventory itself creates a .captures directory. */
class ReadonlyInventory {
  private bytes = 0;
  private entries = 0;
  readonly observations = new Map<string, BigIntStats>();
  readonly directories = new Map<string, { stat: BigIntStats; handle: FileHandle; children: string[] }>();
  constructor(readonly dataRoot: string) {}

  async directory(directory: string, modes: number[]): Promise<void> {
    assert(directory === this.dataRoot || directory.startsWith(`${this.dataRoot}${path.sep}`));
    assert.equal(await fs.realpath(directory), directory);
    const stat = await fs.lstat(directory, { bigint: true });
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid!()));
    assert(modes.includes(Number(stat.mode & BigInt(0o7777))));
    if (this.directories.has(directory)) { equalStat(this.directories.get(directory)!.stat, stat); return; }
    assert(this.directories.size < maxDirectories && ++this.entries <= maxEntries);
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      equalStat(stat, await handle.stat({ bigint: true }));
      const children = (await fs.readdir(directory)).sort();
      assert(children.length <= maxEntries);
      equalStat(stat, await fs.lstat(directory, { bigint: true }));
      this.observations.set(directory, stat); this.directories.set(directory, { stat, handle, children });
    } catch (error) { await handle.close(); throw error; }
  }

  async children(directory: string, expected: string[]): Promise<void> {
    assert(this.directories.has(directory));
    assert.deepEqual(this.directories.get(directory)!.children, [...expected].sort());
  }

  async file(filename: string, size?: number, checksum?: string, modes = [0o400, 0o500]): Promise<Buffer> {
    assert(filename.startsWith(`${this.dataRoot}${path.sep}`));
    assert.equal(await fs.realpath(filename), filename);
    const stat = await fs.lstat(filename, { bigint: true });
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === BigInt(1) && stat.uid === BigInt(process.getuid!()));
    assert(modes.includes(Number(stat.mode & BigInt(0o7777))) && stat.size <= BigInt(maxFileBytes));
    assert(++this.entries <= maxEntries && this.bytes + Number(stat.size) <= maxBytes);
    if (size !== undefined) assert.equal(Number(stat.size), size);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      equalStat(stat, await handle.stat({ bigint: true }));
      const bytes = Buffer.alloc(Number(stat.size)); let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        assert(read.bytesRead > 0); offset += read.bytesRead;
      }
      assert.equal((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead, 0);
      equalStat(stat, await handle.stat({ bigint: true })); equalStat(stat, await fs.lstat(filename, { bigint: true }));
      if (checksum !== undefined) assert.equal(digest(bytes), checksum);
      this.bytes += bytes.length; this.observations.set(filename, stat); return bytes;
    } finally { await handle.close(); }
  }

  async package(root: string, files: FileEntry[], directories: string[]): Promise<string> {
    assert(!files.some(file => directories.includes(file.path)));
    await this.directory(root, [0o500]);
    for (const name of directories) {
      const parent = path.posix.dirname(name);
      assert(parent === '.' || directories.includes(parent));
      await this.directory(path.join(root, ...name.split('/')), [0o500]);
    }
    for (const name of ['', ...directories]) {
      const children = [...directories, ...files.map(file => file.path)]
        .filter(child => path.posix.dirname(child) === (name || '.')).map(child => path.posix.basename(child));
      await this.children(name ? path.join(root, ...name.split('/')) : root, children);
    }
    // Same byte digest as computeCanvasPluginChecksum: sorted relative path, NUL, bytes, NUL.
    const hash = createHash('sha256');
    for (const file of files) {
      const parent = path.posix.dirname(file.path); assert(parent === '.' || directories.includes(parent));
      const bytes = await this.file(path.join(root, ...file.path.split('/')), file.size, file.checksum);
      hash.update(file.path); hash.update('\0'); hash.update(bytes); hash.update('\0');
    }
    return hash.digest('hex');
  }

  async unchanged(): Promise<void> {
    for (const [filename, stat] of this.observations) {
      equalStat(stat, await fs.lstat(filename, { bigint: true })); assert.equal(await fs.realpath(filename), filename);
    }
    for (const [directory, held] of this.directories) {
      equalStat(held.stat, await held.handle.stat({ bigint: true }));
      assert.deepEqual((await fs.readdir(directory)).sort(), held.children);
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.directories.values()].map(entry => entry.handle.close()));
    assert(results.every(result => result.status === 'fulfilled'), 'Owned directory handle closure failed.');
  }
}

function validateClosure(input: OwnedYjsSandboxPackageUnsealInput): void {
  const receipt = input.packageReceipt, closure = input.closure, published = receipt.published!;
  assert.equal(closure.ownerId, receipt.ownerId); assert.equal(closure.workspaceId, receipt.workspaceId);
  component(closure.agentId); component(closure.sessionId); assert.notEqual(closure.agentId, 'canvas-agent');
  assert(Array.isArray(closure.turns) && closure.turns.length > 0 && closure.turns.length <= 16);
  const markers = new Set<string>(), calls = new Set<string>(), runtimes = new Set<string>();
  for (const turn of closure.turns) {
    const marker = boundedText(turn.marker), done = boundedText(turn.done);
    assert(!markers.has(marker) && marker !== done); markers.add(marker); assert.equal(turn.messageSaved, true);
    const status = record(turn.finalStatus);
    assert.equal(status.sessionId, closure.sessionId); assert.equal(status.phase, 'idle'); assert.equal(status.activeTool, null);
    assert.equal(status.pendingToolCalls, 0); assert.equal(status.canAbort, false);
    assert.deepEqual(status.followUpQueue, []); assert.deepEqual(status.steeringQueue, []);
    assert(Array.isArray(turn.toolResults) && turn.toolResults.length > 0 && turn.toolResults.length <= 32);
    for (const tool of turn.toolResults) {
      const callId = boundedText(tool.toolCallId); assert(!calls.has(callId)); calls.add(callId);
      boundedText(tool.toolName); assert.equal(typeof tool.isError, 'boolean');
      const observed = record(tool.result);
      if (observed.details && typeof observed.details === 'object') {
        const details = record(observed.details);
        assert.notEqual(details.terminateAgentTurn, true); assert.notEqual(details.outcome, 'unknown');
        assert.notEqual(details.outcome, 'outcome_unknown');
      }
      if (tool.toolName !== 'run_canvas_skill_script') continue;
      assert.equal(tool.isError, false);
      const result = record(tool.result), details = record(result.details);
      assert.equal(details.kind, 'skill_script_result'); assert.equal(details.success, true); assert.notEqual(details.error, true);
      assert.equal(details.publishedRevisionRef, published.revisionRef); assert.equal(details.checksum, published.checksum);
      assert(details.runtime === 'node' || details.runtime === 'python'); assert.equal(details.id, details.runtime);
      const expectedRef = createHash('sha256').update(JSON.stringify([
        receipt.resource!.resource.legacyResourceId, published.revisionRef, '', details.id,
      ])).digest('base64url');
      assert.equal(details.scriptRef, `skill-script:v1:${expectedRef}`);
      assert.deepEqual(details.files, []); assert.equal(details.stderr, '');
      assert(typeof details.stdout === 'string' && Buffer.byteLength(details.stdout) <= 64 * 1024);
      const stdout = details.stdout.trim(); assert(stdout.length > 0);
      const script = record(JSON.parse(stdout));
      assert.equal(script.kind, 'native-markdown-sandbox-receipt'); assert.equal(script.runtime, details.runtime);
      assert.equal(script.scratchWritten, true); assert(script.mode === 'deny' || script.mode === 'edit');
      assert.equal(script.edited, script.mode === 'edit');
      assert.deepEqual(script.blockedMutations, ['write', 'append', 'replace', 'rename', 'unlink']);
      runtimes.add(details.runtime);
    }
  }
  assert(runtimes.has('node') && runtimes.has('python'), 'Both genuine script child-close result paths are required.');
  const session = record(closure.sessionDeletion); assert.equal(session.success, true); assert.equal(session.deleted, closure.sessionId);
  const agent = successfulData(closure.agentDeletion); assert.equal(agent.deleted, true); assert.equal(agent.agentId, closure.agentId);
  const activation = successfulData(input.activation);
  assert.equal(activation.enabled, false); assert.equal(activation.resourceRef, published.resourceRef);
  assert.equal(activation.packageRevision, 1); assert.equal(activation.publishedRevisionRef, published.revisionRef);
  const selection = record(input.personalSelection); assert.equal(selection.success, true); assert.equal(selection.name, receipt.skillName);
  assert(Array.isArray(selection.enabledSkills) && selection.enabledSkills.length <= 512 && !selection.enabledSkills.includes(receipt.skillName));
}

async function verifyDatabase(target: OwnedYjsReceipt, input: OwnedYjsSandboxPackageUnsealInput): Promise<void> {
  const receipt = input.packageReceipt, published = receipt.published!, metadata = receipt.resource!.resource;
  const database = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 5000, application_name: 'owned-yjs-sandbox-package-unseal' });
  try {
    await database.connect(); await database.query('BEGIN READ ONLY');
    const identity = (await database.query(`SELECT current_database() AS name,d.oid::text,pg_get_userbyid(d.datdba) AS owner,
      current_user AS role,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()`)).rows[0] as DatabaseIdentity;
    assertDatabaseOwnership(target, identity);
    const user = await database.query('SELECT id FROM "user" WHERE id=$1', [receipt.ownerId]); assert.equal(user.rowCount, 1);
    const workspace = await database.query('SELECT organization_id,status FROM canvas_workspaces WHERE id=$1', [receipt.workspaceId]);
    assert.equal(workspace.rowCount, 1); assert.equal(workspace.rows[0].status, 'active');
    assert.equal(workspace.rows[0].organization_id, process.env.CANVAS_ORGANIZATION_ID);
    assert.equal(receipt.publishedArtifact!.owner.organizationId, workspace.rows[0].organization_id);
    const membership = await database.query('SELECT status FROM organization_user_permissions WHERE user_id=$1 AND organization_id=$2',
      [receipt.ownerId, workspace.rows[0].organization_id]);
    assert.equal(membership.rowCount, 1); assert.equal(membership.rows[0].status, 'active');
    const resources = await database.query('SELECT * FROM capability_resources WHERE resource_ref=$1 OR (artifact_name=$2 AND storage_owner_user_id=$3)',
      [published.resourceRef, receipt.skillName, receipt.ownerId]);
    assert.equal(resources.rowCount, 1); const row = resources.rows[0];
    for (const [key, expected] of Object.entries({ resource_ref: published.resourceRef, artifact_name: receipt.skillName,
      resource_type: 'skill', source_type: 'standalone', storage_scope_type: 'user', storage_owner_user_id: receipt.ownerId,
      ownership_type: 'user', owner_user_id: receipt.ownerId, created_by_user_id: receipt.ownerId, status: 'active',
      legacy_resource_id: metadata.legacyResourceId })) assert.equal(row[key], expected);
    assert.equal(Number(row.metadata_revision), metadata.metadataRevision); assert.equal(Number(row.grants_revision), metadata.grantsRevision);
    const states = await database.query('SELECT * FROM capability_package_states WHERE resource_ref=$1', [published.resourceRef]);
    assert.equal(states.rowCount, 1); assert.equal(Number(states.rows[0].package_revision), 1);
    assert.equal(states.rows[0].current_published_revision_ref, published.revisionRef);
    assert.equal(states.rows[0].kind, 'skill'); assert.equal(states.rows[0].name, receipt.skillName);
    assert.deepEqual(JSON.parse(String(states.rows[0].current_source_stamp)), receipt.resource!.state!.currentSourceStamp);
    const versions = await database.query('SELECT * FROM capability_package_versions WHERE resource_ref=$1', [published.resourceRef]);
    assert.equal(versions.rowCount, 1); const version = versions.rows[0];
    for (const [key, expected] of Object.entries({ revision_ref: published.revisionRef, kind: 'skill', name: receipt.skillName,
      version: published.version, checksum: published.checksum, published_by_user_id: receipt.ownerId,
      source_resource_ref: published.sourceResourceRef, source_checksum: published.sourceChecksum })) assert.equal(version[key], expected);
    assert.deepEqual(normalizeFiles(JSON.parse(String(version.files))), normalizeFiles(published.files));
    assert.equal(Number(version.total_bytes), published.totalBytes);
    assert.equal(version.base_revision_ref, published.baseRevisionRef); assert.equal(version.source_revision_ref, published.sourceRevisionRef);
    assert.deepEqual(JSON.parse(String(version.source_stamp)), published.sourceStamp);
    const absent = async (sql: string, values: string[]) => assert.equal((await database.query(sql, values)).rows[0].count, 0);
    await absent('SELECT COUNT(*)::integer AS count FROM capability_package_drafts WHERE resource_ref=$1 OR draft_ref=$2', [published.resourceRef, receipt.draft!.draftRef]);
    await absent('SELECT COUNT(*)::integer AS count FROM agents WHERE agent_id=$1', [input.closure.agentId]);
    await absent('SELECT COUNT(*)::integer AS count FROM pi_sessions WHERE agent_id=$1 OR (session_id=$2 AND user_id=$3)',
      [input.closure.agentId, input.closure.sessionId, receipt.ownerId]);
    await absent('SELECT COUNT(*)::integer AS count FROM file_agent_turns WHERE source_session_id=$1 AND user_id=$2 AND outcome IS NULL',
      [input.closure.sessionId, receipt.ownerId]);
    await database.query('COMMIT');
  } finally { await database.end(); }
}

async function main(): Promise<void> {
  // The genuine target guard is first, before reading caller-selected input or any package tree.
  const target = await requireOwnedYjsQaTarget();
  assert.equal(process.argv.length, 3);
  const inputFile = process.argv[2], results = process.env.CANVAS_YJS_QA_RESULTS!;
  assert(path.isAbsolute(inputFile) && inputFile.startsWith(`${results}${path.sep}`));
  const inputBytes = await privateBytes(inputFile, 8 * 1024 * 1024);
  const input = JSON.parse(inputBytes.toString()) as OwnedYjsSandboxPackageUnsealInput;
  assert.equal(input.version, 1); assert.equal(input.kind, 'owned-yjs-sandbox-package-unseal-v1'); assert.equal(input.fixtureNonce, target.nonce);
  const receipt = input.packageReceipt;
  assert.equal(receipt.kind, 'owned-native-markdown-sandbox-skill-v1'); assert.equal(receipt.nonce, target.nonce);
  assert.equal(receipt.phase, 'ready'); assert.equal(receipt.pendingMutation, null); assert.equal(receipt.ownerId, target.actorId);
  component(receipt.ownerId); component(receipt.workspaceId); assert.equal(receipt.skillName, `native-sandbox-${target.nonce}`);
  assert(receipt.draft && receipt.published && receipt.publishedArtifact && receipt.resource && receipt.source);
  const published = receipt.published, draft = receipt.draft, resource = receipt.resource;
  const resourceUuid = reference(published.resourceRef, 'canvas-resource'), revisionUuid = reference(published.revisionRef, 'canvas-package-revision');
  const draftUuid = reference(draft.draftRef, 'canvas-package-draft');
  assert.equal(published.kind, 'skill'); assert.equal(published.name, receipt.skillName); assert.equal(published.version, '1.0.0');
  assert.equal(published.contractVersion, 1); assert.equal(published.publishedByUserId, receipt.ownerId); assert.equal(published.baseRevisionRef, null);
  assert.equal(draft.name, receipt.skillName); assert.equal(draft.actorUserId, receipt.ownerId); assert.equal(draft.resourceRef, published.resourceRef);
  assert.equal(draft.kind, 'skill'); assert.equal(draft.operation, 'fork'); assert.equal(draft.basePackageRevision, 0);
  assert.equal(draft.basePublishedRevisionRef, null); assert.equal(resource.resource.resourceRef, published.resourceRef);
  assert.equal(resource.resource.ownership.type, 'user'); assert.equal(resource.resource.createdByUserId, receipt.ownerId);
  assert.deepEqual(receipt.publishedArtifact, { ...published, owner: resource.resource.ownership });
  assert.equal(receipt.publishedArtifact.owner.ownerUserId, receipt.ownerId);
  assert(resource.state); assert.equal(resource.state.packageRevision, 1); assert.equal(resource.state.currentPublishedRevisionRef, published.revisionRef);
  assert.equal(resource.access.canManage, true); assert.equal(resource.readOnly, false); assert.deepEqual(resource.published, published);
  assert(receipt.activation && receipt.personalSelection);
  assert.equal(receipt.activation.enabled, true); assert.equal(receipt.activation.resourceRef, published.resourceRef);
  assert.equal(receipt.activation.packageRevision, 1); assert.equal(receipt.activation.publishedRevisionRef, published.revisionRef);
  assert.equal(receipt.personalSelection.name, receipt.skillName); assert(receipt.personalSelection.enabledSkills.includes(receipt.skillName));
  assert.equal(receipt.source.descriptor.readOnly, true); assert.equal(receipt.source.descriptor.sourceStamp.name, 'create-plugin');
  assert.equal(receipt.source.resourceRef, 'canvas-capability:v1:skill:system:core:create-plugin');
  assert.equal(published.sourceResourceRef, receipt.source.resourceRef); assert.equal(published.sourceChecksum, receipt.source.descriptor.sourceStamp.checksum);
  assert.equal(draft.sourceResourceRef, receipt.source.resourceRef);
  const expected = normalizeFiles(receipt.expectedFiles); assert.deepEqual(normalizeFiles(published.files), expected);
  assert.equal(published.totalBytes, expected.reduce((sum, file) => sum + file.size, 0)); assert.match(published.checksum, /^[a-f0-9]{64}$/u);
  assert(Array.isArray(receipt.draftRevisions) && receipt.draftRevisions.length > 0 && receipt.draftRevisions.length <= 64);
  assert.equal(receipt.draftRevisions.length, draft.draftRevision);
  validateClosure(input);
  const inventory = new ReadonlyInventory(target.dataRoot);
  const userRoot = path.join(target.dataRoot, 'users', receipt.ownerId), packageRoot = path.join(userRoot, 'capability-packages');
  const draftsRoot = path.join(packageRoot, 'drafts', draftUuid), publishedRoot = path.join(packageRoot, 'published', resourceUuid);
  try {
    // These ancestors are checked but never modified; sibling packages are not traversed.
    await inventory.directory(target.dataRoot, [0o700]);
    for (const directory of [path.join(target.dataRoot, 'users'), userRoot, packageRoot,
      path.join(packageRoot, 'drafts'), path.join(packageRoot, 'published')]) await inventory.directory(directory, [0o700, 0o750, 0o755]);
    await inventory.directory(draftsRoot, [0o700, 0o500]); await inventory.directory(publishedRoot, [0o700, 0o500]);
    await inventory.children(draftsRoot, receipt.draftRevisions.map((_, index) => String(index + 1)));
    await inventory.children(publishedRoot, [revisionUuid]);
    for (const [index, revision] of receipt.draftRevisions.entries()) {
      assert.equal(revision.draftRef, draft.draftRef); assert.equal(revision.resourceRef, published.resourceRef);
      assert.equal(revision.name, receipt.skillName); assert.equal(revision.actorUserId, receipt.ownerId); assert.equal(revision.draftRevision, index + 1);
      const files = normalizeFiles(revision.files), directories = normalizeDirectories(revision.directories);
      const container = path.join(draftsRoot, String(index + 1));
      await inventory.directory(container, [0o700, 0o500]); await inventory.children(container, [receipt.skillName]);
      const checksum = await inventory.package(path.join(container, receipt.skillName), files, directories);
      if (index === receipt.draftRevisions.length - 1) {
        assert.equal(revision.checksum, published.checksum); assert.equal(checksum, published.checksum); assert.deepEqual(files, expected);
      } else assert.equal(revision.checksum, null);
    }
    const finalRevision = receipt.draftRevisions[receipt.draftRevisions.length - 1];
    const publishedContainer = path.join(publishedRoot, revisionUuid);
    await inventory.directory(publishedContainer, [0o700, 0o500]); await inventory.children(publishedContainer, [receipt.skillName, 'published.json']);
    assert.equal(await inventory.package(path.join(publishedContainer, receipt.skillName), expected,
      normalizeDirectories(finalRevision.directories)), published.checksum);
    const marker = Buffer.from(`${JSON.stringify({ contractVersion: 1, resourceRef: published.resourceRef,
      revisionRef: published.revisionRef, checksum: published.checksum })}\n`);
    assert.deepEqual(await inventory.file(path.join(publishedContainer, 'published.json'), marker.length, digest(marker), [0o400]), marker);
    const registryPath = path.join(userRoot, 'skills', 'registry.json');
    await inventory.directory(path.dirname(registryPath), [0o700, 0o750, 0o755]);
    const registry = record(JSON.parse((await inventory.file(registryPath, undefined, undefined, [0o600, 0o644])).toString()));
    assert.equal(registry.version, 1); const pointer = record(record(registry.skills)[receipt.skillName]);
    assert.equal(pointer.name, receipt.skillName); assert.equal(pointer.packageManaged, true); assert.equal(pointer.packageDefaultEnabled, false);
    assert.equal(pointer.packageResourceRef, published.resourceRef); assert.equal(pointer.publishedRevisionRef, published.revisionRef);
    assert.equal(pointer.checksum, published.checksum); assert.equal(pointer.version, published.version);
    assert.equal(pointer.resourceId, resource.resource.legacyResourceId); assert.equal(pointer.ownerUserId, receipt.ownerId);
    assert.equal(pointer.installDir, path.join(publishedContainer, receipt.skillName)); assert.equal(pointer.skillPath, path.join(pointer.installDir as string, 'SKILL.md'));
    const settingsPath = path.join(userRoot, 'settings', 'skills.json');
    await inventory.directory(path.dirname(settingsPath), [0o700, 0o750, 0o755]);
    const selection = record(JSON.parse((await inventory.file(settingsPath, undefined, undefined, [0o600, 0o644])).toString()));
    assert.equal(selection.version, 1); assert(Array.isArray(selection.enabledSkills) && selection.enabledSkills.length > 0
      && selection.enabledSkills.length <= 512 && selection.enabledSkills.every(value => typeof value === 'string')
      && !selection.enabledSkills.includes(receipt.skillName));
    await verifyDatabase(target, input);
    await inventory.unchanged();
    assert.deepEqual(await privateBytes(inputFile, 8 * 1024 * 1024), inputBytes, 'The private receipt changed.');
    // Validate everything globally before the first mutation. Held directory FDs prevent symlink substitution.
    let changed = 0;
    for (const [directory, held] of inventory.directories) {
      if (!(directory === draftsRoot || directory.startsWith(`${draftsRoot}${path.sep}`)
        || directory === publishedRoot || directory.startsWith(`${publishedRoot}${path.sep}`))) continue;
      if ((held.stat.mode & BigInt(0o7777)) !== BigInt(0o500)) continue;
      equalStat(held.stat, await fs.lstat(directory, { bigint: true })); equalStat(held.stat, await held.handle.stat({ bigint: true }));
      await held.handle.chmod(0o700);
      const after = await held.handle.stat({ bigint: true }); assert.equal(after.mode & BigInt(0o7777), BigInt(0o700));
      assert.equal(after.dev, held.stat.dev); assert.equal(after.ino, held.stat.ino); changed += 1;
    }
    assert(changed > 0); await inventory.close();
    console.log(`OWNED_YJS_SANDBOX_PACKAGE_UNSEAL_PASS directories=${changed} draftRevisions=${receipt.draftRevisions.length} publications=1`);
  } catch (error) {
    await inventory.close().catch(() => undefined); throw error;
  }
}

void main().catch(() => {
  console.error('Owned native sandbox package unseal stopped; preserve its target and private receipts.');
  process.exitCode = 1;
});
