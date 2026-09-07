import { useCallback, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { getSchema } from '@tiptap/core';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../../app/lib/markdown/rich-markdown-codec';
import type { CollaborationDocument } from '../../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../../app/lib/collaboration/types';

export const initialMarkdown = location.search.includes('unsupported')
  ? '# Raw HTML\n\n<div>Keep exactly</div>\n' : '1. First item\n\n2. Second item\n';
const doc = new Y.Doc();
doc.getText('content').insert(0, initialMarkdown);
const provider = { awareness: new Awareness(doc), on() {}, off() {},
  disconnect() { document.body.dataset.disconnected = 'true'; },
  connect() { document.body.dataset.disconnected = 'false'; },
};
const session = { documentId: 'migration-copy', lifecycleGeneration: 1, representation: 'plain_text', permission: 'write',
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
    if (!doc.getXmlFragment('body').length) {
      const manager = createRichMarkdownManager();
      prosemirrorJSONToYXmlFragment(getSchema(richMarkdownCodecExtensions()), manager.parse(initialMarkdown), doc.getXmlFragment('body'));
    }
    document.body.dataset.refreshed = 'true';
    setCurrent({ ...session, representation: 'tiptap_xml', lifecycleGeneration: 2 });
  }, []);
  return { session: current, error: null, retry };
}

export function useCollaborationDocument(input: { enabled: boolean; session: CollaborationSessionResponse }) {
  return input.enabled ? { ...collaboration, session: input.session } : null;
}
