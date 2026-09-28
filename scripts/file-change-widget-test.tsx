import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createTranslator } from 'use-intl/core';

import messages from '../messages/en.json';
import { readFileChangeAppData } from '../app/lib/tool-apps/file-change-data';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/en/notebook' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const data = {
  contractVersion: 1, id: `fvcg-${'c'.repeat(64)}`, workspaceId: 'workspace-1',
  operation: 'edit_file', status: 'superseded', createdAt: '2026-09-26T10:00:00.000Z',
  entries: [{
    id: 'entry-1', ordinal: 0, pathHint: 'docs/plan.md', state: 'superseded',
    operationId: 'operation-original', revisionId: null, additions: null, deletions: null,
    proposal: {
      contractVersion: 1, proposalId: 'proposal-original', rootProposalId: 'proposal-original',
      lineageId: 'lineage-1', graphRevision: 8, lifecycle: 'superseded', status: 'stale_lifecycle',
      successors: [
        { proposalId: 'proposal-next-a', operationId: 'operation-next-a', relation: 'extends', lifecycle: 'open' },
        { proposalId: 'proposal-next-b', operationId: 'operation-next-b', relation: 'replaces', lifecycle: 'open' },
      ],
      moreSuccessors: true,
    },
  }],
};
const translator = createTranslator({ locale: 'en', messages: messages.chat.toolApp });
const internals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === './use-widget' && parent?.filename.endsWith('/file-change-group.tsx')) {
    return { useWidget: () => ({ data: readFileChangeAppData(data), failed: false, t: translator }) };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    await act(async () => { await import('../app/tool-widgets/file-change-group'); });
    const rendered = document.body.textContent ?? '';
    assert.match(rendered, /Superseded proposal/iu,
      'a graph supersession is not mislabeled as a newer file revision');
    assert.match(rendered, /Root proposal/iu);
    assert.match(rendered, /Status changed/iu,
      'the evaluation status is visible as text, including in the compact widget');
    assert.match(rendered, /2 successors: Extends, Replaces/iu,
      'both successor relations are explicit rather than picking a latest branch');
    assert.match(rendered, /More successors are available/iu);
    assert.equal(document.querySelectorAll('button').length, 0,
      'the embedded widget remains read-only; navigation belongs to the chat host');
  } finally {
    internals._load = originalLoad;
  }
  console.log('File-change widget shows graph lifecycle and successor relations without in-frame actions.');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
