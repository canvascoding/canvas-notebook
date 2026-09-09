import 'server-only';

import { Y } from '@/app/lib/collaboration/server-runtime';
import { richMarkdownFromYDoc } from '@/app/lib/collaboration/markdown-state';
import type { Doc } from 'yjs';
import { BLOCK_TREE_KEY } from '@/app/lib/collaboration/block-tree';
import type { TextCollaborationRepresentation } from '@/app/lib/collaboration/types';

/** Validate a guest update on an isolated copy before it reaches the shared room. */
export function assertFileGuestUpdateAllowed(document: Doc, update: Uint8Array, representation: TextCollaborationRepresentation) {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(candidate, update);
    const allowedRoots = representation === 'tiptap_blocks'
      ? [BLOCK_TREE_KEY, 'frontmatter', 'bodyFinalLineEnding']
      : ['content', 'body', 'frontmatter', 'bodyFinalLineEnding'];
    if ([...candidate.share.keys()].some((key) => !allowedRoots.includes(key))) throw new Error('Guest updates may only edit this document.');
    if (Y.encodeStateAsUpdate(candidate).byteLength > 20 * 1024 * 1024) throw new Error('The shared document exceeds the collaboration storage limit.');
    const content = representation === 'plain_text' ? candidate.getText('content').toString() : richMarkdownFromYDoc(candidate);
    if (Buffer.byteLength(content) > 5 * 1024 * 1024) throw new Error('Shared Markdown may not exceed 5 MiB.');
  } finally { candidate.destroy(); }
}
