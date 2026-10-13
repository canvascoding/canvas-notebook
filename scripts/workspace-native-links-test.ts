import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { readWorkspaceDocumentCatalogue, workspaceDocumentCatalogueInPathScope, type WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { SqlConnection } from '../app/lib/db';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { buildWorkspaceNativeLinkGraph } from '../app/lib/markdown/workspace-native-link-graph';
import { buildWorkspaceNativeLinkSnapshot } from '../app/lib/markdown/workspace-native-link-snapshot';
import { createWorkspaceNativeFileOperationPlan } from '../app/lib/markdown/workspace-native-file-operation-planner';
import { rebindNativeCloneLink } from '../app/lib/markdown/workspace-native-link-clone';
import type { NativeDocumentLinkInventory, NativeNamespaceEntry, NativeWorkspaceLinkSnapshot } from '../app/lib/markdown/workspace-link-contract-v2';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const workspace: WorkspaceContext = { workspaceId: 'native-ws', organizationId: null, workspaceType: 'personal',
  rootPath: '/no-native-link-test-files', legacy: false, status: 'active',
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };

function stateFor(doc: Y.Doc, path = 'note.md', representation: PersistedCollaborationState['representation'] = 'tiptap_blocks',
  workspaceId = workspace.workspaceId): PersistedCollaborationState {
  return { documentId: `${workspaceId}:${path}`, workspaceId, organizationId: null, path, representation,
    lifecycleGeneration: 1, schemaVersion: 1, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 7, checkpointSequence: 0, persistedAt: 100, checkpointedAt: null, canonicalHash: null,
    serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
}

function inventory(markdown: string, path: string, representation: PersistedCollaborationState['representation'] = 'tiptap_blocks',
  workspaceId = workspace.workspaceId): NativeDocumentLinkInventory {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(markdown) : createRichMarkdownYDoc(markdown, representation);
  try { return inspectPersistedDocumentLinks(stateFor(doc, path, representation, workspaceId)); }
  finally { doc.destroy(); }
}

function snapshot(documents: NativeDocumentLinkInventory[], extra: Array<{ path: string; kind?: NativeNamespaceEntry['kind'] }> = [],
  workspaceId = workspace.workspaceId): NativeWorkspaceLinkSnapshot {
  const namespace: NativeNamespaceEntry[] = documents.map(({ document }) => ({ workspaceId, path: document.path, kind: 'file',
    identity: `document:${document.documentId}:${document.lifecycleGeneration}`, documentId: document.documentId,
    lifecycleGeneration: document.lifecycleGeneration, filesystemIdentity: null }));
  for (const entry of extra) namespace.push({ workspaceId, path: entry.path, kind: entry.kind ?? 'file',
    identity: `disk:${entry.path}`, documentId: null, lifecycleGeneration: null, filesystemIdentity: `disk:${entry.path}` });
  const gaps = documents.flatMap((entry) => entry.coverage.gaps);
  const body = { contractVersion: 2 as const, workspaceId, namespace, documents, coverage: { complete: gaps.length === 0, gaps } };
  return { ...body, snapshotProof: nativeLinkJsonProof(body) };
}

function catalogue(state: PersistedCollaborationState): WorkspaceDocumentCatalogueEntry {
  return { id: state.documentId, lineage_id: 'lineage', path: state.path, workspace_id: state.workspaceId, organization_id: state.organizationId,
    status: 'active', state_version: 7, has_persisted_state: true, has_state_history: false, lifecycle_generation: 1,
    authority: 'initialized', state_status: 'active', state_path: state.path, state_workspace_id: state.workspaceId, state_organization_id: state.organizationId };
}

test('schema-valid export failure still has complete stable native links and preserves table attributes', () => {
  const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| [Target](target.md) |', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
      (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
    }
    tree.read().check(); assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
    const first = inspectPersistedDocumentLinks(stateFor(doc));
    assert.deepEqual(first.coverage, { complete: true, gaps: [] });
    assert.equal(first.links.length, 1); assert.equal(first.links[0].ref.kind, 'link-mark');
    assert.equal(first.links[0].targetPathText, 'target.md');
    const second = inspectPersistedDocumentLinks(stateFor(doc));
    assert.equal(first.links[0].id, second.links[0].id);
    assert.match(JSON.stringify(tree.read().toJSON()), /"colwidth":\[120\]/u);
  } finally { doc.destroy(); }
});

test('native attributes are decoded once; plain Markdown spans remain a different contract', () => {
  const rich = inventory('[😀](folder/name%2520.md#Part) [[Target#Heading|Alias]]\n\n![Image](img.png)', 'note.md');
  assert.equal(rich.coverage.complete, true);
  assert.equal(rich.links.find((link) => link.syntax === 'inline-link')?.targetPathText, 'folder/name%20.md');
  assert.equal(rich.links.find((link) => link.syntax === 'inline-image')?.ref.kind, 'node-attribute');
  const wiki = rich.links.find((link) => link.kind === 'wiki')!;
  assert.equal(wiki.alias, 'Alias'); assert.equal(wiki.fragment, 'Heading');
  const plain = inventory('😀 [x](folder/name%2520.md#Part)', 'note.md', 'plain_text');
  const ref = plain.links[0].ref;
  assert.equal(ref.kind, 'plain-target');
  if (ref.kind === 'plain-target') { assert.equal(ref.targetStart, 7); assert.equal(ref.expected, 'folder/name%2520.md#Part'); }
});

test('rich literal Markdown and HTML are not ghost links; actual marks inside nested content are links', () => {
  const doc = createRichMarkdownYDoc('Literal', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    const paragraph = [...tree.records.entries()].find(([, record]) => (record.get('shape') as { type: string }).type === 'paragraph')!;
    const text = tree.content(paragraph[0]).toArray()[0] as Y.XmlText;
    text.delete(0, text.length); text.insert(0, '[x](ghost.md) [[ghost]] <a href="ghost.md">x</a>');
    const parsed = inspectPersistedDocumentLinks(stateFor(doc));
    assert.equal(parsed.links.length, 0); assert.equal(parsed.coverage.complete, true);
  } finally { doc.destroy(); }
  const nested = inventory('> [!note] Title\n> [Callout](callout.md)\n\n- [List](list.md)\n\n<details><summary>Title</summary>\n\n[Details](details.md)\n\n</details>\n\nText[^a]\n\n[^a]: [Foot](foot.md)', 'note.md');
  assert.equal(nested.coverage.complete, true);
  assert.deepEqual(nested.links.map((link) => link.targetPathText).sort(), ['callout.md', 'details.md', 'foot.md', 'list.md']);
});

test('a single link across formatting runs keeps one range; unrelated native code is link-free', () => {
  const parsed = inventory('[A **bold** end](target.md)\n\n`[Code](code.md)`\n\n```\n[[code]]\n```', 'note.md');
  assert.equal(parsed.coverage.complete, true); assert.equal(parsed.links.length, 1);
  assert.equal(parsed.links[0].ref.kind, 'link-mark');
});

test('unknown raw attributes and mark attributes make coverage incomplete even when schema normalization ignores them', () => {
  const doc = createRichMarkdownYDoc('[Target](target.md)', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    const paragraph = [...tree.records.entries()].find(([, record]) => (record.get('shape') as { type: string }).type === 'paragraph')!;
    (paragraph[1].get('attributes') as Y.Map<unknown>).set('futureHref', 'hidden.md');
    const first = inspectPersistedDocumentLinks(stateFor(doc));
    assert.equal(first.coverage.complete, false); assert(first.coverage.gaps.some((gap) => gap.attribute === 'paragraph.futureHref'));
    const text = tree.content(paragraph[0]).toArray()[0] as Y.XmlText;
    text.format(0, text.length, { link: { href: 'target.md', futureHref: 'hidden.md' } });
    const second = inspectPersistedDocumentLinks(stateFor(doc));
    assert(second.coverage.gaps.some((gap) => gap.attribute === 'link.futureHref'));
    doc.getText('futureBody').insert(0, '[hidden](hidden.md)');
    assert(inspectPersistedDocumentLinks(stateFor(doc)).coverage.gaps.some((gap) => gap.attribute === 'root.futureBody'));
  } finally { doc.destroy(); }
});

test('legacy XML atoms expose unsupported mark carriers as a coverage gap instead of dropping them', () => {
  const doc = createRichMarkdownYDoc('[[Target]]', 'tiptap_xml');
  try {
    const paragraph = doc.getXmlFragment('body').toArray()[0] as Y.XmlElement;
    const atom = paragraph.toArray().find((child) => child instanceof Y.XmlElement && child.nodeName === 'obsidianWikiLink') as Y.XmlElement;
    assert(atom); atom.setAttribute('link', { href: 'other.md' } as unknown as string);
    const parsed = inspectPersistedDocumentLinks(stateFor(doc, 'note.md', 'tiptap_xml'));
    assert.equal(parsed.coverage.complete, false);
    assert(parsed.coverage.gaps.some((gap) => gap.attribute === 'obsidianWikiLink.link'));
    assert.equal(parsed.links.filter((link) => link.targetPathText === 'Target').length, 1);
    assert.equal(parsed.links.filter((link) => link.targetPathText === 'other.md').length, 0);
  } finally { doc.destroy(); }
});

test('native graph uses frontmatter aliases and registry-only targets without requiring projection bytes', () => {
  const snap = snapshot([inventory('[[Shared]]', 'note.md'), inventory('---\naliases: [Shared]\ntitle: Visible\n---\n\n# Native', 'folder/target.md')]);
  const graph = buildWorkspaceNativeLinkGraph(snap);
  assert.equal(graph.coverage.complete, true); assert.equal(graph.edges[0].resolution.target?.path, 'folder/target.md');
  assert.equal(graph.documents[1].metadata.title, 'Visible'); assert.equal(graph.documents[1].metadata.headings[0].text, 'Native');
});

test('native move plans target-only recipes and detects new ambiguous Wiki capture in untouched sources', () => {
  const snap = snapshot([inventory('[Target](target.md)', 'note.md'), inventory('# Target', 'target.md')]);
  const plan = createWorkspaceNativeFileOperationPlan({ kind: 'move', sourceWorkspaceId: workspace.workspaceId,
    destinationWorkspaceId: workspace.workspaceId, selections: [{ sourcePath: 'target.md', destinationPath: 'folder/new.md' }], snapshots: [snap] });
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues)); assert.equal(plan.mutations.length, 1);
  assert.equal(plan.mutations[0].nextValue, 'folder/new.md'); assert.equal(plan.mutations[0].reference.kind, 'link-mark');
  const capture = snapshot([inventory('[[Target]]', 'note.md'), inventory('# First', 'one/Target.md'), inventory('# Second', 'other.md')], [{ path: 'one', kind: 'directory' }]);
  const blocked = createWorkspaceNativeFileOperationPlan({ kind: 'move', sourceWorkspaceId: workspace.workspaceId,
    destinationWorkspaceId: workspace.workspaceId, selections: [{ sourcePath: 'other.md', destinationPath: 'two/Target.md' }], snapshots: [capture] });
  assert.equal(blocked.readiness, 'blocked'); assert(blocked.issues.some((issue) => issue.code === 'resolution-changed'));
});

test('same-workspace copy updates cloned links; cross-workspace copy rejects an uncopied source target', () => {
  const snap = snapshot([inventory('[Target](target.md)', 'folder/note.md'), inventory('# Target', 'folder/target.md')], [{ path: 'folder', kind: 'directory' }]);
  const plan = createWorkspaceNativeFileOperationPlan({ kind: 'copy', sourceWorkspaceId: workspace.workspaceId,
    destinationWorkspaceId: workspace.workspaceId, selections: [{ sourcePath: 'folder', destinationPath: 'copy' }], snapshots: [snap] });
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
  // Same relative text remains correct, so no mutation is required.
  assert.equal(plan.mutations.length, 0);
  const destId = 'other-workspace'; const dest = snapshot([inventory('# Coincidence', 'target.md', 'tiptap_blocks', destId)], [], destId);
  const cross = createWorkspaceNativeFileOperationPlan({ kind: 'copy', sourceWorkspaceId: workspace.workspaceId,
    destinationWorkspaceId: destId, selections: [{ sourcePath: 'folder/note.md', destinationPath: 'note.md' }], snapshots: [snap, dest] });
  assert.equal(cross.readiness, 'blocked'); assert(cross.issues.some((issue) => issue.code === 'uncopied-cross-workspace-target'));
  const fullCopy = createWorkspaceNativeFileOperationPlan({ kind: 'copy', sourceWorkspaceId: workspace.workspaceId,
    destinationWorkspaceId: destId, selections: [{ sourcePath: 'folder', destinationPath: 'copied' }], snapshots: [snap, dest] });
  assert.equal(fullCopy.readiness, 'ready', JSON.stringify(fullCopy.issues));
  assert.equal(fullCopy.mutations[0].cloneSelection, 'folder');
});

test('copy rebinds every link against proven fresh IDs and never reuses source relative positions', () => {
  const markdown = '[Target](target.md) [[Wiki|Alias]]';
  const doc = createRichMarkdownYDoc(markdown, 'tiptap_blocks');
  const cloneDoc = createRichMarkdownYDoc(markdown, 'tiptap_blocks');
  try {
    const source = inspectPersistedDocumentLinks(stateFor(doc, 'source.md'));
    const clone = inspectPersistedDocumentLinks(stateFor(cloneDoc, 'clone.md'));
    const schema = getSchema(richMarkdownSchemaExtensions());
    const sourceJSON = new CollaborationBlockTree(doc, schema).read().toJSON();
    const cloneJSON = new CollaborationBlockTree(cloneDoc, schema).read().toJSON();
    const mapping: Record<string, string> = {};
    const mapNodes = (a: typeof sourceJSON, b: typeof cloneJSON) => {
      if (a.attrs?.id) mapping[a.attrs.id] = b.attrs.id;
      for (const [index, child] of (a.content ?? []).entries()) mapNodes(child, b.content[index]);
    };
    mapNodes(sourceJSON, cloneJSON);
    const receipt = { version: 1 as const, source: { documentId: source.document.documentId,
      lifecycleGeneration: 1, stateProof: source.version.stateProof }, clone: { documentId: clone.document.documentId,
      lifecycleGeneration: 1, stateProof: clone.version.stateProof }, blockIdMapping: mapping };
    for (const link of source.links) {
      const rebound = rebindNativeCloneLink({ source, clone, sourceLinkId: link.id, receipt });
      assert(clone.links.includes(rebound)); assert.notEqual(nativeLinkJsonProof(link.ref), nativeLinkJsonProof(rebound.ref));
    }
    assert.throws(() => rebindNativeCloneLink({ source, clone, sourceLinkId: source.links[0].id,
      receipt: { ...receipt, blockIdMapping: {} } }), /incomplete/u);
    assert.throws(() => rebindNativeCloneLink({ source, clone, sourceLinkId: source.links[0].id,
      receipt: { ...receipt, clone: { ...receipt.clone, stateProof: 'wrong' } } }), /certify/u);
  } finally { doc.destroy(); cloneDoc.destroy(); }
});

test('delete recipes unlink backlinks but incomplete, corrupt-proof and selected unresolved sources remain blocked', () => {
  const snap = snapshot([inventory('[Target](target.md)', 'note.md'), inventory('# Target', 'target.md')]);
  const plan = createWorkspaceNativeFileOperationPlan({ kind: 'delete', sourceWorkspaceId: workspace.workspaceId,
    destinationWorkspaceId: workspace.workspaceId, selections: [{ sourcePath: 'target.md' }], snapshots: [snap] });
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues)); assert.equal(plan.mutations[0].action, 'unlink');
  const corrupt = createWorkspaceNativeFileOperationPlan({ kind: 'move', sourceWorkspaceId: workspace.workspaceId,
    destinationWorkspaceId: workspace.workspaceId, selections: [{ sourcePath: 'target.md', destinationPath: 'new.md' }], snapshots: [{ ...snap, snapshotProof: 'incorrect' }] });
  assert(corrupt.issues.some((issue) => issue.code === 'snapshot-proof-mismatch'));
  const unresolved = snapshot([inventory('[Missing](missing.md)', 'note.md')]);
  const blocked = createWorkspaceNativeFileOperationPlan({ kind: 'move', sourceWorkspaceId: workspace.workspaceId,
    destinationWorkspaceId: workspace.workspaceId, selections: [{ sourcePath: 'note.md', destinationPath: 'folder/note.md' }], snapshots: [unresolved] });
  assert(blocked.issues.some((issue) => issue.code === 'unresolved-selected-source-link'));
});

test('catalogue includes initialized documents without projections and scopes exact paths plus descendants', async () => {
  const doc = createPlainTextYDoc('durable');
  try {
    const initialized = catalogue(stateFor(doc, 'folder/note.md', 'plain_text'));
    const pristine = { ...initialized, id: 'pristine', path: 'folder/new.md', state_version: 0, has_persisted_state: false,
      lifecycle_generation: null, state_status: null, state_path: null, state_workspace_id: null, state_organization_id: null };
    const missing = { ...pristine, id: 'missing', path: 'folder/history.md', has_state_history: true };
    const queries: Array<{ sql: string; args: unknown }> = [];
    const connection = { get: async (sql: string, args: unknown) => { queries.push({ sql, args }); return undefined; },
      all: async (sql: string, args: unknown) => { queries.push({ sql, args }); return [initialized, pristine, missing]; } } as unknown as SqlConnection;
    const rows = await readWorkspaceDocumentCatalogue(connection, workspace, { paths: ['folder'] });
    assert.deepEqual(rows.map((row) => row.authority), ['initialized', 'pristine', 'missing-state']);
    assert(queries.every(({ sql }) => sql.includes('left(') && sql.includes('unnest($2::text[])')));
    assert(queries.every(({ args }) => nativeLinkJsonProof(args) === nativeLinkJsonProof([workspace.workspaceId, ['folder']])));
    assert.equal(workspaceDocumentCatalogueInPathScope(rows, ['folder/note.md']).length, 1);
    await assert.rejects(readWorkspaceDocumentCatalogue(connection, workspace, { paths: ['../outside'] }), /canonical/u);
    assert.deepEqual(await readWorkspaceDocumentCatalogue(connection, workspace, { paths: [] }), []);
  } finally { doc.destroy(); }
});

test('catalogue rejects active orphan, archived state and organization conflicts before any disk fallback', async () => {
  const doc = createPlainTextYDoc('durable');
  try {
    const row = catalogue(stateFor(doc));
    for (const changed of [{ ...row, state_status: 'archived' }, { ...row, organization_id: 'foreign' }, { ...row, lifecycle_generation: 0 }]) {
      const connection = { get: async () => undefined, all: async () => [changed] } as unknown as SqlConnection;
      await assert.rejects(readWorkspaceDocumentCatalogue(connection, workspace), /identity-conflict/u);
    }
    const orphanConnection = { get: async () => ({ document_id: 'orphan', path: 'note.md' }) } as unknown as SqlConnection;
    await assert.rejects(readWorkspaceDocumentCatalogue(orphanConnection, workspace), /orphan-state/u);
  } finally { doc.destroy(); }
});

test('snapshot unions zero-byte/missing disk and registry namespace without reading Markdown source bytes', async () => {
  const doc = createRichMarkdownYDoc('[Target](target.md)', 'tiptap_blocks');
  const target = createRichMarkdownYDoc('# Target', 'tiptap_blocks');
  try {
    const states = [stateFor(doc), stateFor(target, 'target.md')];
    const calls: string[] = [];
    const connection = { run: async (sql: string) => { calls.push(sql); }, close: async () => { calls.push('close'); } } as unknown as SqlConnection;
    const snap = await buildWorkspaceNativeLinkSnapshot(workspace, { workspace }, {
      buildDiskSnapshot: async (_workspaceId, _options, inspection) => {
        assert.equal(inspection?.readMarkdownContent, false);
        return { workspaceId: workspace.workspaceId, entries: [{ path: 'note.md', kind: 'file', identity: 'zero-projection', markdownContent: '' }] };
      },
      openConnection: async () => connection, readCatalogue: async () => states.map(catalogue),
      loadState: async (_connection, documentId) => states.find((state) => state.documentId === documentId) ?? null,
    });
    assert.equal(snap.coverage.complete, true); assert.equal(snap.namespace.length, 2);
    assert.equal(snap.documents[0].links[0].targetPathText, 'target.md');
    assert.equal(buildWorkspaceNativeLinkGraph(snap).edges[0].resolution.target?.documentId, states[1].documentId);
    assert.equal(snap.namespace.find((entry) => entry.path === 'target.md')?.filesystemIdentity, null);
    assert.deepEqual(calls, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'close']);
  } finally { doc.destroy(); target.destroy(); }
});

test('unregistered Markdown and catalogue failure stay incomplete, independently of readable disk bytes', async () => {
  const connection = { run: async () => undefined, close: async () => undefined } as unknown as SqlConnection;
  for (const catalogueFailure of [false, true]) {
    const snap = await buildWorkspaceNativeLinkSnapshot(workspace, { workspace }, {
      buildDiskSnapshot: async () => ({ workspaceId: workspace.workspaceId, entries: [{ path: 'note.md', kind: 'file', identity: 'disk', markdownContent: '# Disk' }] }),
      openConnection: async () => connection, readCatalogue: async () => { if (catalogueFailure) throw new Error('unsafe'); return []; },
    });
    assert.equal(snap.coverage.complete, false); assert(snap.coverage.gaps.some((gap) => gap.code === 'uninitialized-source'));
    assert.equal(snap.documents.length, 0);
  }
});

test('MDX is explicitly uninspected and disk namespace drift invalidates the database snapshot', async () => {
  const connection = { run: async () => undefined, close: async () => undefined } as unknown as SqlConnection;
  const mdx = await buildWorkspaceNativeLinkSnapshot(workspace, { workspace }, {
    buildDiskSnapshot: async () => ({ workspaceId: workspace.workspaceId, entries: [{ path: 'note.mdx', kind: 'file', identity: 'disk' }] }),
    openConnection: async () => connection, readCatalogue: async () => [],
  });
  assert.equal(mdx.coverage.complete, false); assert(mdx.coverage.gaps.some((gap) => gap.code === 'unsupported-source'));
  let reads = 0;
  const drifted = await buildWorkspaceNativeLinkSnapshot(workspace, { workspace }, {
    buildDiskSnapshot: async () => ({ workspaceId: workspace.workspaceId, entries: [{ path: 'image.png', kind: 'file', identity: String(reads++) }] }),
    openConnection: async () => connection, readCatalogue: async () => [],
  });
  assert.equal(reads, 2); assert.equal(drifted.coverage.complete, false); assert(drifted.coverage.gaps.some((gap) => gap.code === 'identity-conflict'));
});
