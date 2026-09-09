import assert from 'node:assert/strict';
import { Y } from '../app/lib/collaboration/server-runtime';
import { assertFileGuestUpdateAllowed } from '../app/lib/file-guests/update-policy';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';

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
  console.log('file-guest-update-test: isolated validation rejects extra document roots and oversized content');
} finally { document.destroy(); peer.destroy(); }
