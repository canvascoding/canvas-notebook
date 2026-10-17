import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { createRef, useState } from 'react';
import { build } from 'esbuild';
import vm from 'node:vm';
import type { Editor } from '@tiptap/core';
import { parseChatBody, projectChatBodyText, deriveChatBodySelection, canonicalChatBodyIntent,
  type ChatBodyV1, type ChatReferenceBundleV1 } from '../app/lib/chat/chat-body-contracts';
import { chatBodyToInlineEditorDocument, chatInlineReferenceIconKey, inlineEditorDocumentToChatBody,
  inlineEditorPositionToTextOffset, inlineEditorTextOffsetToPosition } from '../app/lib/chat/inline-editor';
import type { ChatInlineEditorHandle, ChatInlineEditorProps } from '../app/components/canvas-agent-chat/ChatInlineEditor';

// Genuine Tiptap schema/history/React NodeViews in jsdom. This is not browser,
// SQL, provider, source-use, receipt, routing or final-admission evidence.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://inline-editor.fixture.invalid', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'Element', 'Node', 'Event',
  'MutationObserver', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent', 'DOMParser', 'DOMRect', 'DocumentFragment', 'Text',
  'requestAnimationFrame', 'cancelAnimationFrame'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const empty = (): ChatBodyV1 => ({ version: 1, parts: [], bundles: [] });
const plain = (text: string): ChatBodyV1 => ({ version: 1, parts: text ? [{ type: 'text', text }] : [], bundles: [] });
const bundle = (account = 'account-a', id = 'bundle-a', caption = 'Canva · Marketing'): ChatReferenceBundleV1 => ({ id, caption,
  primary: { selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: {
    kind: 'personal', profileId: 'profile-a', accountBinding: 'account', accountId: account,
    connectionRef: `composio-personal:profile-a:${account}` } }, requirement: 'optional', toolCap: ['CREATE'] },
  supporting: [], packageConnections: [] });
const oneReference = (value = bundle()): ChatBodyV1 => ({ version: 1,
  parts: [{ type: 'extension_reference', occurrenceId: 'occurrence-a', bundleId: value.id }], bundles: [value] });

async function main() {
  const { render, screen, fireEvent, act, waitFor, cleanup } = await import('@testing-library/react');
  const { ChatInlineEditor } = await import('../app/components/canvas-agent-chat/ChatInlineEditor');
  const handle = createRef<ChatInlineEditorHandle>();
  let current = empty(), changes = 0, submissions = 0, cases = 0;
  let replaceBody: (body: ChatBodyV1) => void = () => { throw new Error('Harness is not mounted.'); };
  let setOptions: (props: Partial<ChatInlineEditorProps>) => void = () => { throw new Error('Harness is not mounted.'); };
  const selections: { from: number; to: number }[] = [];
  function Harness({ initial = empty() }: { initial?: ChatBodyV1 }) {
    const [body, setBody] = useState(initial), [options, updateOptions] = useState<Partial<ChatInlineEditorProps>>({});
    replaceBody = value => { current = value; setBody(value); }; setOptions = updateOptions;
    return <ChatInlineEditor ref={handle} body={body} onBodyChange={value => { current = value; changes++; setBody(value); }}
      onSelectionChange={range => selections.push(range)} onSubmit={() => { submissions++; }} placeholder="Write a message" {...options} />;
  }
  const check = (name: string) => { cases++; console.log(`PASS ${name}`); };
  const tiptap = () => (screen.getByRole('textbox') as HTMLElement & { editor: Editor }).editor;
  const set = async (body: ChatBodyV1) => { await act(async () => replaceBody(body)); };
  try {
    const initial = plain('🙂 e\u0301 /Can rest\nnext'); current = initial;
    render(<Harness initial={initial} />);
    await waitFor(() => assert(handle.current && tiptap()));
    assert.equal(screen.getByRole('textbox', { name: 'Write a message' }).getAttribute('aria-disabled'), 'false', 'Initial mounted editor has its accessible name before any edit.');
    const slash = projectChatBodyText(initial).indexOf('/Can'), original = projectChatBodyText(initial);
    await act(async () => {
      handle.current!.setSelection(slash + 4);
      assert.deepEqual(handle.current!.getSelection(), { from: slash + 4, to: slash + 4 });
      assert.equal(handle.current!.insertReference(bundle(), { from: slash, to: slash + 4 }), true);
      assert.equal(projectChatBodyText(current), original.slice(0, slash) + bundle().caption + original.slice(slash + 4), 'Body callback is synchronous.');
    });
    assert.equal(deriveChatBodySelection(current)?.selections[0].selection.kind, 'composio');
    assert.equal(current.parts.filter(part => part.type === 'extension_reference').length, 1);
    assert.equal(current.bundles.length, 1);
    assert.deepEqual(handle.current!.getSelection(), { from: slash + bundle().caption.length, to: slash + bundle().caption.length });
    assert(screen.getByText(bundle().caption)); assert.equal(screen.getByTestId('plugin-extension-avatar-initials').textContent, 'CM');
    const atom = screen.getByText(bundle().caption).closest('[data-type="extension-reference"]')!;
    assert.equal(atom.getAttribute('contenteditable'), 'false');
    assert.equal(atom.hasAttribute('selection'), false); assert.equal(atom.hasAttribute('accountSelectionRef'), false);
    assert.equal(atom.getAttribute('data-bundle-id'), bundle().id);
    check('actual controlled inline insertion replaces only slash range, preserves Unicode/newline and synchronously emits exact public body');

    const cache = new Map(current.bundles.map(value => [value.id, value])), document = tiptap().state.doc;
    for (let position = 1; position < document.content.size; position++) {
      const resolved = document.resolve(position);
      if (!resolved.parent.isTextblock) continue;
      const textOffset = inlineEditorPositionToTextOffset(document, cache, position);
      assert.equal(inlineEditorTextOffsetToPosition(document, cache, textOffset), position);
    }
    assert.equal(inlineEditorTextOffsetToPosition(document, cache, slash + 1, -1), inlineEditorTextOffsetToPosition(document, cache, slash));
    assert.equal(inlineEditorTextOffsetToPosition(document, cache, slash + 1, 1), inlineEditorTextOffsetToPosition(document, cache, slash + bundle().caption.length));
    assert.deepEqual(canonicalChatBodyIntent(inlineEditorDocumentToChatBody(chatBodyToInlineEditorDocument(current), cache)), canonicalChatBodyIntent(current));
    check('real ProseMirror positions roundtrip UTF16 projection and projected partial reference selections snap to atomic boundaries');

    await set(oneReference());
    const stored = structuredClone(current);
    await act(async () => { handle.current!.setSelection(1, 2); assert.equal(tiptap().commands.deleteSelection(), true); });
    assert.equal(projectChatBodyText(current), ''); assert.equal(current.bundles.length, 0); assert.equal(deriveChatBodySelection(current), null);
    await act(async () => { assert.equal(tiptap().commands.undo(), true); });
    assert.deepEqual(current, stored);
    await act(async () => { assert.equal(tiptap().commands.redo(), true); });
    assert.equal(current.bundles.length, 0);
    await act(async () => { assert.equal(tiptap().commands.undo(), true); handle.current!.focusEnd(); });
    await act(async () => { assert.equal(handle.current!.insertReference(bundle()), true); });
    assert.equal(current.bundles.length, 1); assert.equal(current.parts.filter(part => part.type === 'extension_reference').length, 2);
    assert.equal(deriveChatBodySelection(current)?.selections.length, 1);
    await act(async () => { assert.equal(tiptap().commands.undo(), true); });
    assert.deepEqual(current, stored, 'Insertion is its own undo step.');
    check('actual atom deletion removes unreachable bundles, undo/redo restores cache and duplicate visible occurrences dedupe the context');

    await set(plain('leftRIGHT'));
    await act(async () => { assert.equal(handle.current!.replaceText('middle\nline', { from: 4, to: 4 }), true); });
    assert.equal(projectChatBodyText(current), 'leftmiddle\nlineRIGHT');
    await act(async () => { assert.equal(handle.current!.replaceText('', { from: 4, to: 15 }), true); });
    assert.equal(projectChatBodyText(current), 'leftRIGHT');
    await set(plain(''));
    const html = '<span data-type="extension-reference" data-bundle-id="bundle-a">Canva</span>';
    await act(async () => fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { getData: (type: string) => type === 'text/plain' ? html : '<b>forged</b>' } }));
    assert.equal(projectChatBodyText(current), html); assert.equal(current.bundles.length, 0); assert.equal(deriveChatBodySelection(current), null);
    assert.equal(screen.getByRole('textbox').querySelector('[data-type="extension-reference"]'), null);
    await act(async () => setOptions({ onPaste: event => event.preventDefault() }));
    await act(async () => fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { getData: () => 'ignored attachment paste' } }));
    assert.equal(projectChatBodyText(current), html);
    check('plain paste never parses markup or restores copied authority; multiline dictation replacement and parent attachment capture remain supported');

    await act(async () => setOptions({}));
    await set(oneReference());
    const slice = tiptap().state.doc.slice(1, tiptap().state.doc.content.size - 1);
    const serializer = tiptap().options.editorProps.clipboardTextSerializer!;
    assert.equal(serializer.call(tiptap().view, slice, tiptap().view), bundle().caption);
    await act(async () => { handle.current!.focusEnd(); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' }); });
    assert.equal(submissions, 1);
    await act(async () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 }));
    assert.equal(submissions, 1);
    await act(async () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter', shiftKey: true }));
    assert.equal(submissions, 1); assert.equal(projectChatBodyText(current), bundle().caption + '\n');
    await act(async () => setOptions({ onKeyDown: event => { if (event.key === 'Enter') event.preventDefault(); } }));
    await act(async () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' }));
    assert.equal(submissions, 1);
    check('actual plain clipboard projection, Enter send, ShiftEnter hardbreak, composition and popup interception use the same editor');

    await set(oneReference(bundle()));
    const iconKey = chatInlineReferenceIconKey(bundle().primary.selection);
    await act(async () => setOptions({ icons: { [iconKey]: { url: 'https://logos.fixture.invalid/canva.svg', sourceKey: 'actual-presentation-source' } } }));
    assert.equal(screen.getByTestId('plugin-extension-avatar-image').getAttribute('src'), 'https://logos.fixture.invalid/canva.svg');
    assert.equal(screen.getByTestId('plugin-extension-avatar').dataset.sourceKey, 'actual-presentation-source');
    const beforeIcons = structuredClone(current), readChanges = changes;
    await act(async () => fireEvent.error(screen.getByTestId('plugin-extension-avatar-image')));
    assert.equal(screen.getByTestId('plugin-extension-avatar-initials').textContent, 'CM');
    assert.deepEqual(current, beforeIcons); assert.equal(changes, readChanges);
    const other = oneReference(bundle('account-b', 'bundle-b', 'Canva · Design'));
    assert.notEqual(chatInlineReferenceIconKey(other.bundles[0].primary.selection), iconKey);
    await set(other);
    assert.equal(screen.queryByTestId('plugin-extension-avatar-image'), null);
    assert.equal(screen.getByText('Canva · Design').textContent, 'Canva · Design');
    assert.equal(screen.getByTestId('plugin-extension-avatar-initials').textContent, 'CD');
    assert.equal(tiptap().can().undo(), false, 'External draft/session replacement clears the old history.');
    check('source-keyed genuine avatar maps isolate accounts, image failure uses real caption initials and external body reset clears stale undo state');

    await act(async () => setOptions({ disabled: true }));
    assert.equal(screen.getByRole('textbox', { name: 'Write a message' }).getAttribute('aria-disabled'), 'true');
    const disabledBody = structuredClone(current), beforeDisabled = changes;
    await act(async () => {
      assert.equal(handle.current!.insertReference(bundle()), false);
      assert.equal(handle.current!.replaceText('blocked'), false);
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
    });
    assert.equal(tiptap().isEditable, false); assert.deepEqual(current, disabledBody); assert.equal(changes, beforeDisabled); assert.equal(submissions, 1);
    await act(async () => setOptions({}));
    await set(empty());
    await act(async () => {
      for (let index = 0; index < 5; index++) assert.equal(handle.current!.insertReference(bundle(`account-${index}`, `bundle-${index}`)), true);
      const before = structuredClone(current);
      assert.equal(handle.current!.insertReference(bundle('sixth', 'sixth')), false);
      assert.deepEqual(current, before);
      assert.equal(handle.current!.insertReference({ ...bundle(), accountSelectionRef: 'forged-receipt' } as ChatReferenceBundleV1), false);
      assert.deepEqual(current, before);
    });
    assert.equal(current.bundles.length, 5);
    assert.equal(JSON.stringify(tiptap().getJSON()).includes('account-'), false, 'Editor JSON has local node IDs, not bundle selections.');
    assert(selections.length > 0);
    check('disabled editor, max-five body validation and strict public bundle parser reject complete invalid insertions atomically');

    const pin = { resourceRef: 'canvas-resource:00000000-0000-4000-8000-000000000001',
      publishedRevisionRef: 'canvas-package-revision:00000000-0000-4000-8000-000000000002', checksum: 'a'.repeat(64) };
    const mcp = { selection: { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'shared' as const,
      connectionRef: 'canvas-connection:00000000-0000-4000-8000-000000000003', bindingRevision: 9 } }, requirement: 'required' as const, toolCap: ['READ'] };
    const plugin: ChatReferenceBundleV1 = { id: 'plugin', caption: 'Design plugin', primary: { selection: { kind: 'plugin', package: pin,
      skillSelection: { kind: 'subset', relativeRoots: ['skills/layout'] } }, requirement: 'optional', toolCap: null }, supporting: [mcp],
    packageConnections: [{ package: pin, declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'design', alternativeKey: 'mcp:design', connectionSelection: mcp.selection }] };
    const skill: ChatReferenceBundleV1 = { id: 'skill', caption: 'Layout skill', primary: { selection: { kind: 'skill', package: pin,
      origin: 'plugin_child', relativeRoot: 'skills/layout' }, requirement: 'required', toolCap: null }, supporting: [], packageConnections: [] };
    const allKinds: ChatBodyV1 = { version: 1,
      parts: [plugin, skill, { ...bundle(), id: 'account' }, { ...bundle(), id: 'mcp', primary: mcp }].map((value, index) =>
        ({ type: 'extension_reference', occurrenceId: `all-${index}`, bundleId: value.id })),
      bundles: [plugin, skill, { ...bundle(), id: 'account' }, { ...bundle(), id: 'mcp', primary: mcp }] };
    const allCache = new Map(allKinds.bundles.map(value => [value.id, value])), allDocument = chatBodyToInlineEditorDocument(allKinds);
    assert.deepEqual(inlineEditorDocumentToChatBody(allDocument, allCache), parseChatBody(allKinds));
    allDocument.content![0].content!.shift();
    const withoutPlugin = inlineEditorDocumentToChatBody(allDocument, allCache);
    assert.equal(withoutPlugin.bundles.some(value => value.id === plugin.id), false);
    assert.equal(deriveChatBodySelection(withoutPlugin)?.packageConnections, undefined);
    assert.equal(deriveChatBodySelection(withoutPlugin)?.selections.length, 3, 'Deleting plugin keeps separately visible skill/MCP/account.');
    check('all four kinds retain exact pins/caps/accounts; removing owning plugin drops its mappings while independent references remain');

    const browser = await build({ stdin: { contents: "export * from './app/lib/chat/inline-editor';", resolveDir: process.cwd(), sourcefile: 'inline-adapter-browser-entry.ts' },
      bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'InlineAdapter', metafile: true, logLevel: 'silent' });
    assert(!Object.keys(browser.metafile!.inputs).some(input => /(?:server-only|accepted-turn-selection|durable-message-contracts|app\/lib\/db\/|PluginExtensionAvatar)/u.test(input)));
    const world = vm.createContext({ TextEncoder }); vm.runInContext(browser.outputFiles[0].text, world);
    const result = vm.runInContext(`JSON.stringify(InlineAdapter.chatBodyToInlineEditorDocument(JSON.parse(${JSON.stringify(JSON.stringify(oneReference()))})))`, world);
    assert.deepEqual(JSON.parse(result), chatBodyToInlineEditorDocument(oneReference()));
    assert.deepEqual(parseChatBody(inlineEditorDocumentToChatBody({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hardBreak' }] }] }, new Map())), plain('\n'));
    assert.throws(() => inlineEditorDocumentToChatBody({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'extensionReference', attrs: { occurrenceId: 'orphan', bundleId: 'missing' } }] }] }, new Map()));
    check('browser-target adapter bundle runs without Node globals and rejects missing reference cache');
    console.log(JSON.stringify({ status: 'PASS', cases, browser: false, providers: 0, database: false }));
  } finally { cleanup(); dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
