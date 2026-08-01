import assert from 'node:assert/strict';

import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import {
  activeMarkdownOutlineAnchor,
  collectMarkdownOutline,
} from '../app/lib/editor/markdown-outline';

const schema = getSchema([StarterKit]);
const document = schema.nodeFromJSON({
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Overview' }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Intro' }],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Details' }],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Details' }],
    },
  ],
});

const headings = collectMarkdownOutline(document);
assert.deepEqual(
  headings.map(({ anchor, level, text }) => ({ anchor, level, text })),
  [
    { anchor: 'overview', level: 1, text: 'Overview' },
    { anchor: 'details', level: 2, text: 'Details' },
    { anchor: 'details-1', level: 2, text: 'Details' },
  ],
);
assert.equal(activeMarkdownOutlineAnchor(headings, headings[0].position), 'overview');
assert.equal(activeMarkdownOutlineAnchor(headings, headings[1].position), 'details');
assert.equal(activeMarkdownOutlineAnchor(headings, document.content.size), 'details-1');

console.log('markdown outline tests passed');
