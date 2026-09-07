import { Editor, getSchema } from '@tiptap/core';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import { CanvasUniqueID } from '../../app/lib/editor/canvas-unique-id';
import { MarkdownDomSelection } from '../../app/components/editor/MarkdownDomSelection';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../../app/lib/markdown/rich-markdown-codec';

const extensions = richMarkdownCodecExtensions();
const manager = createRichMarkdownManager();
const author = new Y.Doc();
const recorded = document.getElementById('initial-update')?.textContent;
if (recorded) Y.applyUpdate(author, Uint8Array.from(atob(recorded), (character) => character.charCodeAt(0)));
else {
  const seed = prosemirrorJSONToYDoc(getSchema(extensions), generateUniqueIds(manager.parse(
    '# Regression copy\n\n1. First item\n2. Middle item\n3. Last item',
  ), extensions), 'body');
  Y.applyUpdate(author, Y.encodeStateAsUpdate(seed)); seed.destroy();
}
const peer = new Y.Doc();
Y.applyUpdate(peer, Y.encodeStateAsUpdate(author));
for (const [local, remote] of [[author, peer], [peer, author]]) {
  local.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') queueMicrotask(() => Y.applyUpdate(remote, update, 'peer'));
  });
}
const publish = () => {
  document.getElementById('update')!.textContent = btoa(String.fromCharCode(...Y.encodeStateAsUpdate(author)));
};
const editors = [author, peer].map((doc, index) => new Editor({
  element: document.getElementById(index === 0 ? 'author' : 'peer')!,
  extensions: [
    MarkdownDomSelection,
    ...extensions.filter((extension) => extension.name !== 'uniqueID')
      .map((extension) => extension.name === 'starterKit' ? extension.configure({ undoRedo: false }) : extension),
    CanvasUniqueID.configure({ types: 'all', filterTransaction: (transaction) => !isChangeOrigin(transaction) }),
    Collaboration.configure({ document: doc, field: 'body' }),
  ],
  onUpdate: publish,
}));
publish();
window.addEventListener('pagehide', () => { editors.forEach((editor) => editor.destroy()); author.destroy(); peer.destroy(); });
