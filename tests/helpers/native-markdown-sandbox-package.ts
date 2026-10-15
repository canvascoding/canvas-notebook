import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { createCapabilityResourceId } from '../../app/lib/capabilities/reference';
import type {
  CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackageFileEntry,
  CapabilityPackagePublishedRevision, CapabilityPackageState, CapabilityPackageTreeEntry,
} from '../../app/lib/capabilities/packages/contracts';

export type NativeMarkdownSandboxDraftRevisionReceipt = Pick<CapabilityPackageDraft,
  'draftRef' | 'resourceRef' | 'draftRevision' | 'name' | 'actorUserId'> & {
    /** Draft tree returns exact file hashes; only a valid package validation returns its whole checksum. */
    files: CapabilityPackageFileEntry[] | null;
    /** Includes inherited empty directories left by normal file-delete mutations. */
    directories: string[] | null;
    checksum: string | null;
  };

/** Exact API observations for the enclosing disposable QA target, including partial setup.
 * The existing organization/plugin cleanup helper is deliberately incompatible:
 * this is a user-owned standalone skill forked from an untouched core package.
 * Preserve this receipt on failure. Discard an unpublished draft only after a
 * fresh creator-owned status/CAS check. Published bytes, registry/resource rows
 * and personal selection belong to the enclosing verified owned-DATA teardown;
 * the legacy skill DELETE API does not remove managed immutable publications.
 */
export type NativeMarkdownSandboxPackageCleanupReceipt = {
  kind: 'owned-native-markdown-sandbox-skill-v1';
  nonce: string;
  ownerId: string;
  workspaceId: string;
  skillName: string;
  phase: string;
  pendingMutation: { method: 'POST' | 'PUT' | 'DELETE' | 'PATCH'; path: string } | null;
  source: { resourceRef: string; descriptor: CapabilityPackageDescriptor } | null;
  draft: CapabilityPackageDraft | null;
  draftRevisions: NativeMarkdownSandboxDraftRevisionReceipt[];
  published: CapabilityPackagePublishedRevision | null;
  publishedArtifact: (CapabilityPackagePublishedRevision & {
    owner: { type: 'user'; ownerUserId: string; organizationId: string | null };
  }) | null;
  resource: CapabilityPackageDescriptor | null;
  activation: {
    previousDefaultEnabled: boolean;
    enabled: boolean;
    resourceRef: string;
    packageRevision: number;
    publishedRevisionRef: string;
  } | null;
  personalSelection: { name: string; enabledSkills: string[] } | null;
  expectedFiles: CapabilityPackageFileEntry[];
};

export class NativeMarkdownSandboxPackageSetupError extends Error {
  constructor(readonly cleanupReceipt: NativeMarkdownSandboxPackageCleanupReceipt, cause: unknown) {
    super(`Native Markdown sandbox package setup stopped during ${cleanupReceipt.phase}; preserve its owned QA target and receipt.`, { cause });
    this.name = 'NativeMarkdownSandboxPackageSetupError';
  }
}

const nodeSource = String.raw`const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sdk = require(process.env.CANVAS_SKILL_BRIDGE_MODULE);
const args = sdk.arguments();
assert.deepEqual(Object.keys(args).sort(), ['absolutePath', 'mode', 'path']);
assert.ok(typeof args.path === 'string' && args.path.endsWith('.md') && !path.isAbsolute(args.path));
assert.ok(!args.path.includes('\\') && !args.path.includes('\0') && !args.path.split('/').some(p => p === '..' || p === '.'));
assert.ok(typeof args.absolutePath === 'string' && path.isAbsolute(args.absolutePath) && args.absolutePath.endsWith('/' + args.path));
assert.ok(args.mode === 'deny' || args.mode === 'edit');
const oldText = 'Sandbox target.', newText = 'Sandbox target. Authorized edit.';
const blockedMutations = [];
function denied(name, operation) {
  try { operation(); } catch (error) {
    assert.ok(error && ['EPERM', 'EACCES'].includes(error.code), name + ' must fail at the OS permission boundary');
    blockedMutations.push(name); return;
  }
  throw new Error('Protected Markdown mutation succeeded: ' + name);
}
function readPayload(result) {
  assert.ok(Array.isArray(result.content) && result.content.length === 1 && result.content[0].type === 'text');
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.representation, 'tiptap_blocks');
  assert.ok(value.document && typeof value.document.documentId === 'string');
  assert.ok(Number.isSafeInteger(value.document.lifecycleGeneration) && value.document.lifecycleGeneration > 0);
  assert.ok(Number.isSafeInteger(value.document.schemaVersion) && value.document.schemaVersion > 0);
  assert.ok(value.structure && value.structure.nextOffset === null && Array.isArray(value.structure.blocks));
  return value;
}
async function read() {
  return readPayload(await sdk.call('read_doc', { path: args.path, source: 'blocks', structureLimit: 100, maxChars: 24000 }));
}
(async () => {
  const initial = await read();
  const targets = initial.structure.blocks.filter(b => b.type === 'paragraph' && !b.textTruncated && typeof b.text === 'string' && b.text.includes(oldText));
  assert.equal(targets.length, 1, 'One complete genuine target paragraph is required');
  const target = targets[0];
  assert.equal(target.text.split(oldText).length, 2);
  assert.ok(typeof target.id === 'string' && target.id.length > 0);
  fs.writeFileSync('scratch.txt', 'native-markdown-scratch');
  assert.equal(fs.readFileSync('scratch.txt', 'utf8'), 'native-markdown-scratch');
  const replacement = path.join(process.cwd(), 'replacement.md');
  fs.writeFileSync(replacement, 'Raw replacement must never reach the workspace.');
  denied('write', () => fs.writeFileSync(args.absolutePath, 'Raw write must fail.'));
  denied('append', () => fs.appendFileSync(args.absolutePath, 'Raw append must fail.'));
  denied('replace', () => fs.renameSync(replacement, args.absolutePath));
  denied('rename', () => fs.renameSync(args.absolutePath, path.join(process.cwd(), 'renamed.md')));
  denied('unlink', () => fs.unlinkSync(args.absolutePath));
  assert.deepEqual(blockedMutations, ['write', 'append', 'replace', 'rename', 'unlink']);
  const afterProbe = await read();
  assert.deepEqual(afterProbe.document, initial.document);
  assert.deepEqual(afterProbe.structure, initial.structure, 'Denied writes must not alter the genuine native read');
  if (args.mode === 'edit') {
    await sdk.call('edit_doc', { path: args.path, document: initial.document, blockId: target.id, oldText, newText, expectedOccurrences: 1 });
  }
  const final = args.mode === 'edit' ? await read() : afterProbe;
  assert.deepEqual(final.document, initial.document);
  const finalTarget = final.structure.blocks.find(b => b.id === target.id);
  assert.ok(finalTarget && !finalTarget.textTruncated);
  assert.equal(finalTarget.text, args.mode === 'edit' ? target.text.replace(oldText, newText) : target.text);
  process.stdout.write(JSON.stringify({ kind: 'native-markdown-sandbox-receipt', runtime: 'node', mode: args.mode,
    scratchWritten: true, blockedMutations, document: final.document, blockId: target.id,
    beforeText: target.text, afterText: finalTarget.text, edited: args.mode === 'edit' }) + '\n');
})().catch(error => { process.stderr.write(String(error.code || error.message) + '\n'); process.exitCode = 1; });
`;

const pythonSource = String.raw`import errno
import json
import os
from pathlib import Path
import canvas_skill as sdk

args = sdk.arguments()
assert set(args) == {'path', 'absolutePath', 'mode'}
assert isinstance(args['path'], str) and args['path'].endswith('.md') and not os.path.isabs(args['path'])
assert '\\' not in args['path'] and '\0' not in args['path'] and not any(p in ('.', '..') for p in args['path'].split('/'))
assert isinstance(args['absolutePath'], str) and os.path.isabs(args['absolutePath']) and args['absolutePath'].endswith('/' + args['path'])
assert args['mode'] in ('deny', 'edit')
old_text, new_text = 'Sandbox target.', 'Sandbox target. Authorized edit.'
blocked_mutations = []

def denied(name, operation):
    try:
        operation()
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES), name + ' must fail at the OS permission boundary'
        blocked_mutations.append(name)
        return
    raise AssertionError('Protected Markdown mutation succeeded: ' + name)

def read():
    result = sdk.call('read_doc', {'path': args['path'], 'source': 'blocks', 'structureLimit': 100, 'maxChars': 24000})
    assert isinstance(result.get('content'), list) and len(result['content']) == 1 and result['content'][0]['type'] == 'text'
    value = json.loads(result['content'][0]['text'])
    assert value['representation'] == 'tiptap_blocks'
    assert isinstance(value['document']['documentId'], str) and value['document']['documentId']
    assert type(value['document']['lifecycleGeneration']) is int and value['document']['lifecycleGeneration'] > 0
    assert type(value['document']['schemaVersion']) is int and value['document']['schemaVersion'] > 0
    assert value['structure']['nextOffset'] is None and isinstance(value['structure']['blocks'], list)
    return value

initial = read()
targets = [b for b in initial['structure']['blocks'] if b['type'] == 'paragraph' and not b['textTruncated'] and old_text in b['text']]
assert len(targets) == 1, 'One complete genuine target paragraph is required'
target = targets[0]
assert target['text'].count(old_text) == 1 and isinstance(target['id'], str) and target['id']
Path('scratch.txt').write_text('native-markdown-scratch')
assert Path('scratch.txt').read_text() == 'native-markdown-scratch'
replacement = Path.cwd() / 'replacement.md'
replacement.write_text('Raw replacement must never reach the workspace.')

def write():
    with open(args['absolutePath'], 'w') as handle:
        handle.write('Raw write must fail.')

def append():
    with open(args['absolutePath'], 'a') as handle:
        handle.write('Raw append must fail.')

denied('write', write)
denied('append', append)
denied('replace', lambda: os.replace(replacement, args['absolutePath']))
denied('rename', lambda: os.rename(args['absolutePath'], Path.cwd() / 'renamed.md'))
denied('unlink', lambda: os.unlink(args['absolutePath']))
assert blocked_mutations == ['write', 'append', 'replace', 'rename', 'unlink']
after_probe = read()
assert after_probe['document'] == initial['document']
assert after_probe['structure'] == initial['structure'], 'Denied writes must not alter the genuine native read'
if args['mode'] == 'edit':
    sdk.call('edit_doc', {'path': args['path'], 'document': initial['document'], 'blockId': target['id'],
                         'oldText': old_text, 'newText': new_text, 'expectedOccurrences': 1})
final = read() if args['mode'] == 'edit' else after_probe
assert final['document'] == initial['document']
final_target = next(b for b in final['structure']['blocks'] if b['id'] == target['id'])
assert not final_target['textTruncated']
assert final_target['text'] == (target['text'].replace(old_text, new_text, 1) if args['mode'] == 'edit' else target['text'])
print(json.dumps({'kind': 'native-markdown-sandbox-receipt', 'runtime': 'python', 'mode': args['mode'],
                  'scratchWritten': True, 'blockedMutations': blocked_mutations, 'document': final['document'],
                  'blockId': target['id'], 'beforeText': target['text'], 'afterText': final_target['text'],
                  'edited': args['mode'] == 'edit'}))
`;

/** API-only core fork: no intake, model/provider request or invented runtime receipt. */
export async function createNativeMarkdownSandboxPackage(input: {
  request: APIRequestContext; workspaceId: string; ownerId: string; nonce: string;
}) {
  assert.match(input.nonce, /^[a-z0-9][a-z0-9-]{7,39}$/u);
  for (const value of [input.workspaceId, input.ownerId]) assert.ok(value.trim() === value && value.length > 0 && value.length <= 256);
  const skillName = `native-sandbox-${input.nonce}`;
  const receipt: NativeMarkdownSandboxPackageCleanupReceipt = {
    kind: 'owned-native-markdown-sandbox-skill-v1', nonce: input.nonce, ownerId: input.ownerId,
    workspaceId: input.workspaceId, skillName, phase: 'authenticate', pendingMutation: null,
    source: null, draft: null, draftRevisions: [], published: null, publishedArtifact: null, resource: null,
    activation: null, personalSelection: null, expectedFiles: [],
  };
  const scoped = (route: string) => `${route}?workspaceId=${encodeURIComponent(input.workspaceId)}`;
  const json = async <T,>(response: APIResponse): Promise<T> => {
    try {
      assert.ok(response.ok(), `${receipt.phase} returned HTTP ${response.status()}`);
      const body = await response.json() as { success?: boolean };
      assert.equal(body.success, true, `${receipt.phase} did not return a successful API result`);
      return body as T;
    } finally { await response.dispose(); }
  };
  const call = async <T,>(phase: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', route: string, data?: unknown): Promise<T> => {
    receipt.phase = phase;
    if (method !== 'GET') receipt.pendingMutation = { method, path: route };
    const result = await json<T>(await input.request.fetch(scoped(route), { method, ...(data === undefined ? {} : { data }), maxRedirects: 0 }));
    if (method !== 'GET') receipt.pendingMutation = null;
    return result;
  };
  try {
    const auth = await input.request.get('/api/auth/get-session', { maxRedirects: 0 });
    try { assert.ok(auth.ok()); assert.equal((await auth.json() as { user?: { id?: string } }).user?.id, input.ownerId); }
    finally { await auth.dispose(); }
    const sourceRef = createCapabilityResourceId({ resourceType: 'skill', scopeType: 'system', sourceType: 'core', name: 'create-plugin' });
    const source = (await call<{ data: { package: CapabilityPackageDescriptor } }>('read-core-source', 'GET', `/api/capabilities/packages/${encodeURIComponent(sourceRef)}`)).data.package;
    assert.equal(source.readOnly, true); assert.equal(source.sourceStamp.kind, 'skill'); assert.equal(source.sourceStamp.name, 'create-plugin');
    receipt.source = { resourceRef: sourceRef, descriptor: source };
    let draft = (await call<{ data: { draft: CapabilityPackageDraft } }>('fork-core-source', 'POST', '/api/capabilities/packages/drafts', {
      operation: 'fork', resourceRef: sourceRef, targetName: skillName, ownership: { type: 'user' },
      expectedSourceMetadataRevision: source.resource.metadataRevision, expectedSourceGrantsRevision: source.resource.grantsRevision,
      expectedSourcePackageRevision: source.state?.packageRevision ?? 0, expectedSourcePublishedRevisionRef: source.state?.currentPublishedRevisionRef ?? null,
    })).data.draft;
    receipt.draft = draft;
    assert.equal(draft.kind, 'skill'); assert.equal(draft.name, skillName); assert.equal(draft.actorUserId, input.ownerId); assert.equal(draft.operation, 'fork');
    const route = `/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}`;
    const observeDraftInventory = async () => {
      const observation: NativeMarkdownSandboxDraftRevisionReceipt = {
        draftRef: draft.draftRef, resourceRef: draft.resourceRef, draftRevision: draft.draftRevision,
        name: draft.name, actorUserId: draft.actorUserId, files: null, directories: null, checksum: null,
      };
      receipt.draftRevisions.push(observation);
      const tree = (await call<{ data: { draft: CapabilityPackageDraft; files: CapabilityPackageTreeEntry[] } }>('read-owned-draft-revision-inventory', 'GET', `${route}/tree`)).data;
      assert.equal(tree.draft.draftRef, draft.draftRef); assert.equal(tree.draft.draftRevision, draft.draftRevision);
      assert.equal(tree.draft.resourceRef, draft.resourceRef); assert.equal(tree.draft.actorUserId, input.ownerId);
      assert.ok(Array.isArray(tree.files) && tree.files.length > 0 && tree.files.length <= 512);
      assert.equal(new Set(tree.files.map(file => file.path)).size, tree.files.length);
      const files: CapabilityPackageFileEntry[] = [], directories: string[] = [];
      for (const entry of tree.files) {
        assert.ok(typeof entry.path === 'string' && entry.path.length > 0 && entry.path.length <= 1024);
        assert.ok(!entry.path.includes('\\') && !entry.path.includes('\0')
          && !entry.path.split('/').some(part => part === '' || part === '.' || part === '..'));
        if (entry.type === 'directory') {
          directories.push(entry.path);
          continue;
        }
        assert.equal(entry.type, 'file');
        assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0); assert.match(entry.checksum, /^[a-f0-9]{64}$/u);
        files.push({ path: entry.path, size: entry.size, checksum: entry.checksum,
          ...(entry.mediaType ? { mediaType: entry.mediaType } : {}) });
      }
      assert.ok(files.length > 0 && files.length <= 256 && directories.length <= 256);
      observation.files = files;
      observation.directories = directories;
      return { draft: tree.draft, files, directories };
    };
    const tree = await observeDraftInventory();
    const argumentsSchema = { type: 'object', additionalProperties: false, required: ['path', 'absolutePath', 'mode'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 1024 }, absolutePath: { type: 'string', minLength: 1, maxLength: 4096 }, mode: { enum: ['deny', 'edit'] },
    } };
    const files = new Map<string, string>([
      ['SKILL.md', `---\nname: ${skillName}\ndescription: Verify protected native Markdown files and edit the same document through the declared Node or Python Canvas SDK entrypoint.\nlicense: MIT\nmetadata:\n  version: "1.0.0"\n---\n\nDiscover the selected published entrypoint, inspect its actual schema and readiness, then run the requested runtime. Both entrypoints verify scratch access and five denied direct Markdown mutations. Mode deny reads the native document without an authorized edit; mode edit changes its genuine target paragraph through the declared central edit alias. Keep all scratch outputs private.\n`],
      ['agents/canvas.yaml', `skill:\n  version: "1.0.0"\ninterface:\n  display_name: Native Markdown Sandbox QA\n  short_description: Verify central Markdown editing and OS write protection\n  default_prompt: ${JSON.stringify(`Use $${skillName} and its currently discovered declared runtime to verify the requested owned Markdown document.`)}\n`],
      ['.canvas-skill/runtime.json', JSON.stringify({ version: 1, scripts: (['node', 'python'] as const).map(kind => ({
        id: kind, displayName: `${kind} native Markdown sandbox verification`, runtime: { kind },
        path: `scripts/main.${kind === 'node' ? 'js' : 'py'}`, argumentsSchema,
        tools: [{ alias: 'read_doc', kind: 'native', toolName: 'read' }, { alias: 'edit_doc', kind: 'native', toolName: 'edit_file' }], outputs: [],
      })) }, null, 2) + '\n'],
      ['scripts/main.js', nodeSource], ['scripts/main.py', pythonSource],
    ]);
    receipt.expectedFiles = [...files].map(([filePath, content]) => ({ path: filePath, size: Buffer.byteLength(content), checksum: createHash('sha256').update(content).digest('hex') }));
    for (const file of tree.files) {
      if (files.has(file.path)) continue;
      draft = (await call<{ data: { draft: CapabilityPackageDraft } }>('remove-inherited-file', 'DELETE', `${route}/file`, {
        expectedDraftRevision: draft.draftRevision, path: file.path,
      })).data.draft;
      receipt.draft = draft;
      await observeDraftInventory();
    }
    for (const [filePath, content] of files) {
      draft = (await call<{ data: { draft: CapabilityPackageDraft } }>('write-owned-script-package', 'PUT', `${route}/file`, {
        expectedDraftRevision: draft.draftRevision, path: filePath, encoding: 'base64', content: Buffer.from(content).toString('base64'),
      })).data.draft;
      receipt.draft = draft;
      await observeDraftInventory();
    }
    const validation = (await call<{ data: { validation: { valid: boolean; name: string; version: string; checksum: string; files: CapabilityPackageFileEntry[] } } }>('validate-owned-package', 'POST', `${route}/validate`)).data.validation;
    assert.equal(validation.valid, true); assert.equal(validation.name, skillName); assert.equal(validation.version, '1.0.0');
    assert.match(validation.checksum, /^[a-f0-9]{64}$/u);
    receipt.draftRevisions[receipt.draftRevisions.length - 1].checksum = validation.checksum;
    const inventory = (entries: CapabilityPackageFileEntry[]) => entries.map(({ path: filePath, size, checksum }) => ({ path: filePath, size, checksum })).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(inventory(validation.files), inventory(receipt.expectedFiles));
    const publication = (await call<{ data: { state: CapabilityPackageState; published: CapabilityPackagePublishedRevision } }>('publish-owned-package', 'POST', `${route}/publish`, {
      draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, expectedPackageRevision: 0, expectedPublishedRevisionRef: null,
    })).data;
    receipt.published = publication.published;
    assert.equal(publication.published.resourceRef, draft.resourceRef); assert.equal(publication.published.kind, 'skill');
    assert.equal(publication.published.name, skillName); assert.equal(publication.published.publishedByUserId, input.ownerId);
    assert.equal(publication.published.version, '1.0.0'); assert.equal(publication.published.checksum, validation.checksum);
    assert.equal(publication.published.sourceResourceRef, draft.sourceResourceRef);
    assert.equal(publication.published.sourceChecksum, source.sourceStamp.checksum);
    assert.equal(publication.state.packageRevision, 1); assert.equal(publication.state.currentPublishedRevisionRef, publication.published.revisionRef);
    assert.deepEqual(inventory(publication.published.files), inventory(receipt.expectedFiles));
    const resourceRoute = `/api/capabilities/packages/${encodeURIComponent(draft.resourceRef)}`;
    const resource = (await call<{ data: { package: CapabilityPackageDescriptor } }>('inspect-owned-publication', 'GET', resourceRoute)).data.package;
    receipt.resource = resource;
    assert.equal(resource.resource.resourceType, 'skill'); assert.equal(resource.resource.sourceType, 'standalone');
    assert.equal(resource.resource.ownership.type, 'user');
    if (resource.resource.ownership.type !== 'user') throw new Error('Expected a personal standalone skill.');
    assert.equal(resource.resource.ownership.ownerUserId, input.ownerId); assert.equal(resource.resource.createdByUserId, input.ownerId);
    assert.equal(resource.state?.currentPublishedRevisionRef, publication.published.revisionRef); assert.equal(resource.access.canManage, true);
    receipt.publishedArtifact = { ...publication.published, owner: resource.resource.ownership };
    const activation = (await call<{ data: { enabled: boolean; resourceRef: string; packageRevision: number; publishedRevisionRef: string } }>('activate-owned-publication', 'PATCH', `${resourceRoute}/activation`, {
      enabled: true, expectedDefaultEnabled: resource.defaultEnabled,
      expectedMetadataRevision: resource.resource.metadataRevision, expectedGrantsRevision: resource.resource.grantsRevision,
      expectedPackageRevision: resource.state!.packageRevision, expectedPublishedRevisionRef: publication.published.revisionRef,
    })).data;
    receipt.activation = { previousDefaultEnabled: resource.defaultEnabled, ...activation };
    assert.equal(activation.enabled, true); assert.equal(activation.resourceRef, draft.resourceRef); assert.equal(activation.publishedRevisionRef, publication.published.revisionRef);
    const selection = await call<{ name: string; enabledSkills: string[] }>('select-owned-skill', 'POST', `/api/skills/${encodeURIComponent(skillName)}/enable`);
    receipt.personalSelection = { name: selection.name, enabledSkills: selection.enabledSkills };
    assert.equal(selection.name, skillName); assert.ok(selection.enabledSkills.includes(skillName));
    const activated = (await call<{ data: { package: CapabilityPackageDescriptor } }>('confirm-owned-activation', 'GET', resourceRoute)).data.package;
    assert.equal(activated.defaultEnabled, true);
    assert.equal(activated.state?.currentPublishedRevisionRef, publication.published.revisionRef);
    assert.equal(activated.published?.checksum, publication.published.checksum);
    assert.deepEqual(activated.resource.ownership, resource.resource.ownership);
    receipt.resource = activated;
    receipt.phase = 'ready';
    return { skillName, resourceRef: draft.resourceRef, resourceId: resource.resource.legacyResourceId,
      publishedRevisionRef: publication.published.revisionRef, published: publication.published,
      cleanupReceipt: structuredClone(receipt) };
  } catch (cause) {
    throw new NativeMarkdownSandboxPackageSetupError(structuredClone(receipt), cause);
  }
}
