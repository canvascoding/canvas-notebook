import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { getCodeEditorLifecycleKey } from '../app/lib/collaboration/code-editor-lifecycle';
import {
  createInitialTextCollaborationClientState,
  reduceTextCollaborationClientState,
  textCollaborationLegacyStatus,
} from '../app/lib/collaboration/client-state';

const root = process.cwd();
const source = fs.readFileSync(
  path.join(root, 'app', 'components', 'editor', 'CodeEditor.tsx'),
  'utf8',
);
const collaborationClientSource = fs.readFileSync(
  path.join(root, 'app', 'lib', 'collaboration', 'client.ts'),
  'utf8',
);

assert.match(
  source,
  /const onChangeRef = useRef\(onChange\);/u,
  'CodeMirror must retain the latest parent change handler without replacing its callback',
);
assert.match(
  source,
  /useEffect\(\(\) => \{\s*onChangeRef\.current = onChange;\s*\}, \[onChange\]\);/u,
  'the retained change handler must follow parent callback updates',
);
assert.match(
  source,
  /const handleChange = useCallback\(\(nextValue: string\) => \{\s*onChangeRef\.current\(nextValue\);\s*\}, \[\]\);/u,
  'the callback passed to CodeMirror must stay stable across draft updates',
);
assert.match(
  source,
  /<CodeMirror[\s\S]*?onChange=\{handleChange\}/u,
  'CodeMirror must receive the stable handler so yCollab is not reconfigured on each edit',
);

assert.match(
  source,
  /const collaborationExtensions = useMemo<CodeMirrorExtension\[\]>/u,
  'the yCollab binding must be memoized independently from connection status snapshots',
);
assert.match(
  collaborationClientSource,
  /setComposition: entry\.setComposition,/u,
  'collaboration status snapshots must reuse the registry entry composition handler',
);
assert.match(
  source,
  /nextExtensions\.push\(\.\.\.collaborationExtensions\);/u,
  'the editor extension list must reuse the stable collaboration binding',
);
assert.doesNotMatch(
  source,
  /const extensions = useMemo\([\s\S]*?\n\s*collaboration,\n[\s\S]*?\n\s*\]\);/u,
  'connection status snapshots must not recreate the yCollab binding',
);
assert.match(
  source,
  /<CodeMirror[\s\S]*?key=\{codeEditorLifecycleKey\}/u,
  'CodeMirror must remount when its authoritative Y.Text binding changes',
);

let collaborationState = createInitialTextCollaborationClientState({
  permission: 'write',
  documentSequence: 5,
  checkpointSequence: 5,
  stateVector: 'initial-vector',
});
assert.equal(collaborationState.durability, 'checkpointed_file');
assert.equal(collaborationState.checkpointStateVector, 'initial-vector');
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'indexeddb_hydrated',
});
assert.equal(collaborationState.ready, false, 'IndexedDB hydration alone must not mount an editor');
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'remote_synced',
  permission: 'write',
});
assert.equal(collaborationState.ready, true, 'the editor may mount only after local hydration and remote sync');
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'unsynced_changes',
  count: 1,
});
assert.equal(collaborationState.durability, 'local_pending');
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'checkpointed',
  sequence: 6,
  stateVector: 'older-vector',
  matchesCurrentDocument: false,
});
assert.equal(
  collaborationState.durability,
  'local_pending',
  'a checkpoint for a different state vector must not clear local pending changes',
);
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'unsynced_changes',
  count: 0,
});
assert.equal(collaborationState.durability, 'server_received');
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'checkpoint_superseded',
  sequence: 7,
});
assert.equal(collaborationState.durability, 'checkpoint_pending');
assert.equal(textCollaborationLegacyStatus(collaborationState), 'persisting');
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'checkpointed',
  sequence: 6,
  stateVector: 'stale-vector',
  matchesCurrentDocument: true,
});
assert.equal(
  collaborationState.durability,
  'checkpoint_pending',
  'an out-of-order checkpoint must not change the pending status of a newer document sequence',
);
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'checkpointed',
  sequence: 7,
  stateVector: 'current-vector',
  matchesCurrentDocument: true,
});
assert.equal(collaborationState.durability, 'checkpointed_file');
assert.equal(textCollaborationLegacyStatus(collaborationState), 'saved');
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'authoritative_snapshot',
  documentSequence: 8,
  checkpointSequence: 7,
  stateVector: 'persisted-vector',
  matchesCurrentDocument: true,
});
assert.equal(collaborationState.durability, 'persisted_yjs');
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'authoritative_snapshot',
  documentSequence: 8,
  checkpointSequence: 8,
  stateVector: 'checkpointed-vector',
  matchesCurrentDocument: true,
});
assert.equal(collaborationState.durability, 'checkpointed_file');
collaborationState = reduceTextCollaborationClientState(collaborationState, {
  type: 'authoritative_snapshot',
  documentSequence: 7,
  checkpointSequence: 7,
  stateVector: 'out-of-order-vector',
  matchesCurrentDocument: true,
});
assert.equal(collaborationState.documentSequence, 8, 'out-of-order server snapshots must not regress durability');
assert.equal(collaborationState.checkpointStateVector, 'checkpointed-vector');

const pendingKey = getCodeEditorLifecycleKey({
  workspaceId: 'workspace-1',
  path: 'document.md',
  collaborationRequested: true,
  collaborationRegistryKey: null,
  collaborationBindingReady: false,
});
const generationOneRegistryKey = [
  'workspace-1',
  'document.md',
  'document-1',
  '1',
  'plain_text',
].join('\0');
const generationTwoRegistryKey = [
  'workspace-1',
  'document.md',
  'document-1',
  '2',
  'plain_text',
].join('\0');
const activeKey = getCodeEditorLifecycleKey({
  workspaceId: 'workspace-1',
  path: 'document.md',
  collaborationRequested: true,
  collaborationRegistryKey: generationOneRegistryKey,
  collaborationBindingReady: true,
});
assert.notEqual(
  activeKey,
  pendingKey,
  'activating yCollab must create a fresh EditorView initialized from the authoritative Y.Text',
);
assert.equal(
  activeKey,
  getCodeEditorLifecycleKey({
    workspaceId: 'workspace-1',
    path: 'document.md',
    collaborationRequested: true,
    collaborationRegistryKey: generationOneRegistryKey,
    collaborationBindingReady: true,
  }),
  'status-only collaboration snapshots must retain the active EditorView',
);
assert.notEqual(
  activeKey,
  getCodeEditorLifecycleKey({
    workspaceId: 'workspace-1',
    path: 'document.md',
    collaborationRequested: true,
    collaborationRegistryKey: generationTwoRegistryKey,
    collaborationBindingReady: true,
  }),
  'a new collaboration generation must receive a fresh EditorView',
);

async function verifyAuthoritativeBinding(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost',
  });
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    document: { value: dom.window.document, configurable: true },
    navigator: { value: dom.window.navigator, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
    MutationObserver: { value: dom.window.MutationObserver, configurable: true },
    requestAnimationFrame: {
      value: dom.window.requestAnimationFrame.bind(dom.window),
      configurable: true,
    },
    cancelAnimationFrame: {
      value: dom.window.cancelAnimationFrame.bind(dom.window),
      configurable: true,
    },
  });

  const [{ EditorState }, { EditorView }, { yCollab }, Y] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('y-codemirror.next'),
    import('yjs'),
  ]);
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('content');
  ytext.insert(0, 'authoritative content');
  const pluginErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => pluginErrors.push(args);
  const editorParent = dom.window.document.querySelector('#editor');
  assert.ok(editorParent);
  const editorView = new EditorView({
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: yCollab(ytext, null, { undoManager: false }),
    }),
    parent: editorParent,
  });
  try {
    editorView.dispatch({
      changes: {
        from: 'authoritative '.length,
        to: ytext.length,
        insert: 'edit',
      },
    });
    assert.deepEqual(pluginErrors, [], 'a freshly mounted authoritative binding must not crash yCollab');
    assert.equal(ytext.toString(), 'authoritative edit');
  } finally {
    editorView.destroy();
    ydoc.destroy();
    dom.window.close();
    console.error = originalConsoleError;
  }
}

void verifyAuthoritativeBinding().then(
  () => console.log('code-editor-collaboration-lifecycle-test: ok'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
