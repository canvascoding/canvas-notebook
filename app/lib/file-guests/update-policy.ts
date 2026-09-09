import 'server-only';

import { Y } from '@/app/lib/collaboration/server-runtime';
import { richMarkdownFromYDoc } from '@/app/lib/collaboration/markdown-state';
import type { Doc } from 'yjs';

/** Validate a guest update on an isolated copy before it reaches the shared room. */
export function assertFileGuestUpdateAllowed(document: Doc, update: Uint8Array, representation: 'plain_text' | 'tiptap_xml') {
  const candidate = new Y.Doc();
  try {
    candidate.getText('content');
    candidate.getXmlFragment('body');
    candidate.getText('frontmatter');
    candidate.getText('bodyFinalLineEnding');
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(candidate, update);
    if ([...candidate.share.keys()].some((key) => !['content', 'body', 'frontmatter', 'bodyFinalLineEnding'].includes(key))) throw new Error('Guest updates may only edit this document.');
    if (Y.encodeStateAsUpdate(candidate).byteLength > 20 * 1024 * 1024) throw new Error('The shared document exceeds the collaboration storage limit.');
    const content = representation === 'plain_text' ? candidate.getText('content').toString() : richMarkdownFromYDoc(candidate);
    if (Buffer.byteLength(content) > 5 * 1024 * 1024) throw new Error('Shared Markdown may not exceed 5 MiB.');
  } finally { candidate.destroy(); }
}
