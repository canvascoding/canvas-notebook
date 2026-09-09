import assert from 'node:assert/strict';
import type { XmlText } from 'yjs';
import { Y } from '../app/lib/collaboration/server-runtime';
import { assertFileGuestUpdateAllowed } from '../app/lib/file-guests/update-policy';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { getSchema } from '@tiptap/core';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';

const document = createPlainTextYDoc('# Shared\n');
const peer = new Y.Doc();
try {
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
  const vector = Y.encodeStateVector(document);
  peer.getText('content').insert(0, 'Allowed edit\n');
  assertFileGuestUpdateAllowed(document, Y.encodeStateAsUpdate(peer, vector), 'plain_text');
  assert.equal(document.getText('content').toString(), '# Shared\n', 'Validation does not mutate the live document');
  peer.getMap('agent-command').set('run', 'forbidden');
  assert.throws(() => assertFileGuestUpdateAllowed(document, Y.encodeStateAsUpdate(peer, vector), 'plain_text'), /only edit this document/);
  const tooLarge = createPlainTextYDoc('x'.repeat(5 * 1024 * 1024 + 1));
  try { assert.throws(() => assertFileGuestUpdateAllowed(document, Y.encodeStateAsUpdate(tooLarge), 'plain_text'), /5 MiB/); }
  finally { tooLarge.destroy(); }
  const rich = createRichMarkdownYDoc('# Rich\n\nA paragraph.\n');
  try { assert.doesNotThrow(() => assertFileGuestUpdateAllowed(rich, Y.encodeStateAsUpdate(rich), 'tiptap_xml')); }
  finally { rich.destroy(); }
  const blocks = createRichMarkdownYDoc('# Rich\n\nFirst paragraph.\n\nSecond paragraph.\n', 'tiptap_blocks');
  const movingPeer = new Y.Doc();
  try {
    Y.applyUpdate(movingPeer, Y.encodeStateAsUpdate(blocks));
    const tree = new CollaborationBlockTree(movingPeer, getSchema(richMarkdownCodecExtensions()));
    const movingId = tree.read().child(1).attrs.id;
    tree.move({ blockId: movingId, parentId: null, beforeId: null, operationId: 'guest-move' }, 'guest');
    (tree.content(movingId).get(0) as XmlText).insert(0, 'Guest edit ');
    const original = Y.encodeStateAsUpdate(blocks);
    assert.doesNotThrow(() => assertFileGuestUpdateAllowed(blocks, Y.encodeStateAsUpdate(movingPeer), 'tiptap_blocks'));
    assert.deepEqual(Y.encodeStateAsUpdate(blocks), original, 'Block validation preserves the live binary state');
    for (const forbidden of ['body', 'content', 'agent-command']) {
      const invalid = new Y.Doc();
      try {
        Y.applyUpdate(invalid, Y.encodeStateAsUpdate(movingPeer));
        invalid.getMap(forbidden).set('unexpected', true);
        assert.throws(() => assertFileGuestUpdateAllowed(blocks, Y.encodeStateAsUpdate(invalid), 'tiptap_blocks'), /only edit this document/);
      } finally { invalid.destroy(); }
    }
    assert.throws(() => assertFileGuestUpdateAllowed(blocks, Y.encodeStateAsUpdate(blocks), 'tiptap_xml'), /only edit this document/);
  } finally { movingPeer.destroy(); blocks.destroy(); }
  console.log('file-guest-update-test: isolated validation rejects extra document roots and oversized content');
} finally { document.destroy(); peer.destroy(); }
