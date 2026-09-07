import { Editor, getSchema } from '@tiptap/core';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { CanvasUniqueID } from '../../app/lib/editor/canvas-unique-id';
import { MarkdownDomSelection } from '../../app/components/editor/MarkdownDomSelection';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../../app/lib/markdown/rich-markdown-codec';

const source = '# Regression copy\n\n1. First item\n2. Middle item\n3. Last item\n\nClosing paragraph';
const extensions = richMarkdownCodecExtensions();
const manager = createRichMarkdownManager();
const doc = prosemirrorJSONToYDoc(getSchema(extensions), generateUniqueIds(manager.parse(source), extensions), 'body');
const editors = ['author', 'peer'].map((id) => new Editor({
  element: document.getElementById(id)!,
  extensions: [
    MarkdownDomSelection,
    ...extensions.filter((extension) => extension.name !== 'uniqueID')
      .map((extension) => extension.name === 'starterKit' ? extension.configure({ undoRedo: false }) : extension),
    CanvasUniqueID.configure({ types: 'all', filterTransaction: (transaction) => !isChangeOrigin(transaction) }),
    Collaboration.configure({ document: doc, field: 'body' }),
  ],
  onUpdate: ({ editor }) => {
    document.getElementById('snapshot')!.textContent = JSON.stringify(editor.getJSON());
    document.getElementById('markdown')!.textContent = manager.serialize(editor.getJSON());
  },
}));
window.addEventListener('pagehide', () => { editors.forEach((editor) => editor.destroy()); doc.destroy(); });
