import { useCallback, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { getSchema } from '@tiptap/core';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../../app/lib/markdown/rich-markdown-codec';
import type { CollaborationDocument } from '../../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../../app/lib/collaboration/types';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../../app/lib/collaboration/types';
import { BLOCK_TREE_KEY, CollaborationBlockTree } from '../../app/lib/collaboration/block-tree';

export const initialMarkdown = location.search.includes('unsupported')
  ? '# Raw HTML\n\n<div>Keep exactly</div>\n' : '1. First item\n\n2. Second item\n';
let doc = new Y.Doc();
doc.getText('content').insert(0, initialMarkdown);
const provider = { awareness: new Awareness(doc), on() {}, off() {},
  disconnect() { document.body.dataset.disconnected = 'true'; },
  connect() { document.body.dataset.disconnected = 'false'; },
};
const session = { documentId: 'migration-copy', lifecycleGeneration: 1, representation: 'plain_text', permission: 'write',
  schemaVersion: 1, ...COLLABORATION_CLIENT_CAPABILITIES,
  user: { id: 'test-user', name: 'Test user', color: '#336699', colorLight: '#33669933' },
} as CollaborationSessionResponse;
let checkpoints = 0;
const collaboration = {
  registryKey: 'migration-workspace\0copy.md', doc, provider, ready: true,
  connection: 'live', durability: 'checkpointed_file', status: 'synced', session,
  clientState: { documentSequence: 1, checkpointSequence: 1, unsyncedChanges: 0 },
  setComposition() {},
  async requestCheckpoint() { document.body.dataset.checkpoints = String(++checkpoints); },
} as unknown as CollaborationDocument;

export function useTextCollaborationSession() {
  const [current, setCurrent] = useState(session);
  const retry = useCallback(() => {
    if (!doc.share.has(BLOCK_TREE_KEY)) {
      const manager = createRichMarkdownManager();
      const extensions = richMarkdownCodecExtensions();
      const previous = doc;
      doc = new Y.Doc();
      CollaborationBlockTree.create(doc, getSchema(extensions).nodeFromJSON(generateUniqueIds(manager.parse(initialMarkdown), extensions)));
      provider.awareness.destroy();
      provider.awareness = new Awareness(doc);
      previous.destroy();
    }
    document.body.dataset.refreshed = 'true';
    setCurrent({ ...session, representation: 'tiptap_blocks', lifecycleGeneration: 2 });
  }, []);
  return { session: current, error: null, retry };
}

export function useCollaborationDocument(input: { enabled: boolean; session: CollaborationSessionResponse }) {
  return input.enabled ? { ...collaboration, doc, provider, session: input.session } : null;
}
