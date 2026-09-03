import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import {
  analyzeMarkdownRichMode,
  createRichMarkdownManager,
  richMarkdownCodecExtensions,
  serializeRichMarkdownBody,
} from '../app/lib/markdown/rich-markdown-codec';
import {
  createRichMarkdownYDoc,
  replaceRichMarkdownInYDoc,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from '../app/lib/collaboration/markdown-state';
import { TiptapTransformer, Y } from '../app/lib/collaboration/server-runtime';

// These states exist immediately after a slash command, before any text is typed.
const extensions = richMarkdownCodecExtensions();
const schema = getSchema(extensions);
const manager = createRichMarkdownManager();
for (const markdown of ['>', 'Before\n\n>\n\n## After', '> >', '> Text\n>\n> More']) {
  const parsed = manager.parse(markdown);
  schema.nodeFromJSON(parsed).check();
  const doc = createRichMarkdownYDoc(markdown);
  try {
    assert.equal(richMarkdownFromYDoc(doc), markdown);
    assert.equal(validateRichMarkdownYDoc(doc).valid, true, markdown);
  } finally {
    doc.destroy();
  }
}

const insertedQuote = generateUniqueIds({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
    { type: 'blockquote', content: [{ type: 'paragraph' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'After' }] },
  ],
}, extensions);
const quoteDoc = TiptapTransformer.toYdoc(insertedQuote, 'body', extensions);
try {
  assert.equal(validateRichMarkdownYDoc(quoteDoc).valid, true, 'an inserted empty quote must checkpoint');
  const reopened = new Y.Doc();
  try {
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(quoteDoc));
    assert.equal(richMarkdownFromYDoc(reopened), 'Before\n\n>\n\n## After');
    assert.equal(validateRichMarkdownYDoc(reopened).valid, true);
  } finally {
    reopened.destroy();
  }
} finally {
  quoteDoc.destroy();
}

for (const ending of ['', '\n', '\n\n', '\n\n\n', '\r\n', '\r\n\r\n']) {
  const markdown = `# Prices\n\n- Plan: $20/month\n- Usage: \\~$4/month${ending}`;
  assert.equal(serializeRichMarkdownBody(markdown), markdown, JSON.stringify(ending));
  assert.equal(analyzeMarkdownRichMode(markdown).mode, 'rich');
  const doc = createRichMarkdownYDoc(markdown);
  try {
    assert.equal(richMarkdownFromYDoc(doc), markdown);
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    const replacement = markdown.replace('Prices', 'Updated prices');
    replaceRichMarkdownInYDoc(doc, replacement, { actorType: 'user', actorId: 'regression' });
    assert.equal(richMarkdownFromYDoc(doc), replacement);
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
  } finally {
    doc.destroy();
  }
}

console.log('Empty quotes and original EOF whitespace survive Markdown and Yjs checkpoints.');
