import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://canvas.test/en/notebook?workspaceId=workspace-1',
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'MutationObserver', 'CustomEvent', 'Event', 'DOMException', 'HTMLButtonElement', 'SVGElement'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const proposal = {
  contractVersion: 1, proposalId: 'proposal-original', rootProposalId: 'proposal-original',
  lineageId: 'lineage-1', graphRevision: 8, lifecycle: 'superseded', status: 'stale_lifecycle',
  successors: [
    { proposalId: 'proposal-next-a', operationId: 'operation-next-a', relation: 'extends', lifecycle: 'open' },
    { proposalId: 'proposal-next-b', operationId: 'operation-next-b', relation: 'replaces', lifecycle: 'open' },
  ],
  moreSuccessors: true,
};
const original = {
  id: 'entry-1', ordinal: 0, pathHint: 'docs/plan.md', state: 'superseded',
  operationId: 'operation-original', revisionId: null, additions: null, deletions: null, proposal,
};
const graphData = {
  contractVersion: 1, id: `fvcg-${'a'.repeat(64)}`, workspaceId: 'workspace-1',
  operation: 'edit_file', status: 'superseded', createdAt: '2026-09-26T10:00:00.000Z',
  entries: [original],
};

function button(label: RegExp): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => label.test(candidate.textContent ?? ''));
  assert.ok(result, `button ${label} exists`);
  return result;
}

async function main() {
  const { FileChangeAppActions } = await import('../app/components/canvas-agent-chat/FileChangeAppActions');
  const { closeVersionCenter, useFileVersionCenterStore } = await import('../app/store/file-version-center-store');
  const root = createRoot(document.getElementById('root')!);
  const render = async (data: unknown) => act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileChangeAppActions data={data} refresh={() => {}} />
    </NextIntlClientProvider>,
  ));

  await render(graphData);
  assert.match(document.body.textContent ?? '', /Root proposal · Superseded proposal · Status changed/iu,
    'the graph relation, current state, and evaluated status are visible as text');
  assert.match(document.body.textContent ?? '', /More successors are available/iu);
  const choice = document.querySelector<HTMLDetailsElement>('details');
  assert.ok(choice, 'multiple successors require a choice instead of automatic latest selection');
  assert.match(choice.querySelector('summary')?.textContent ?? '', /Choose from 2 successors/iu);
  assert.equal(choice.querySelectorAll('[data-testid="file-change-successor-option"]').length, 2);
  assert.equal(useFileVersionCenterStore.getState().request, null,
    'rendering successor options does not navigate implicitly');

  await act(async () => { button(/View changes/iu).click(); });
  const primary = useFileVersionCenterStore.getState().request;
  assert.deepEqual(primary?.target, { kind: 'change_group', workspaceId: 'workspace-1',
    changeGroupId: graphData.id, entryId: original.id });
  assert.deepEqual(primary?.selectedEntry, { kind: 'agent_operation', id: original.operationId },
    'closed graph entries still open their exact historical operation');
  assert.equal(primary?.initialView, 'reviews');

  await act(async () => { choice.querySelector('summary')?.click(); });
  assert.equal(choice.open, true, 'the successor picker opens before a successor can be chosen');
  await act(async () => {
    choice.querySelectorAll<HTMLButtonElement>('[data-testid="file-change-successor-option"]')[1]?.click();
  });
  const successor = useFileVersionCenterStore.getState().request;
  assert.deepEqual(successor?.target, { kind: 'lineage', workspaceId: 'workspace-1', lineageId: 'lineage-1' });
  assert.deepEqual(successor?.selectedEntry, { kind: 'agent_operation', id: 'operation-next-b' },
    'an explicit option opens only its authorized exact successor operation');
  assert.equal(successor?.initialView, 'reviews');
  assert.equal(successor?.source, 'chat');

  await act(async () => { closeVersionCenter(); });
  await render({ ...graphData, status: 'included', entries: [{ ...original, state: 'included',
    proposal: { ...proposal, lifecycle: 'included', successors: [proposal.successors[0]], moreSuccessors: false } }] });
  assert.equal(document.querySelector('details'), null, 'one successor is presented as a direct explicit option');
  const soleSuccessor = document.querySelector<HTMLButtonElement>('[data-testid="file-change-successor-option"]');
  assert.ok(soleSuccessor);
  await act(async () => { soleSuccessor.click(); });
  assert.deepEqual(useFileVersionCenterStore.getState().request?.selectedEntry,
    { kind: 'agent_operation', id: 'operation-next-a' }, 'the single option still requires an explicit click');

  await act(async () => { closeVersionCenter(); });
  const revision = { ...original, state: 'superseded', operationId: null, revisionId: 'revision-1' };
  const { proposal: _proposal, ...legacyRevision } = revision;
  await render({ ...graphData, entries: [legacyRevision] });
  assert.equal(document.querySelector('[data-testid="file-change-proposal-entry"]'), null);
  await act(async () => { button(/View changes/iu).click(); });
  const legacy = useFileVersionCenterStore.getState().request;
  assert.deepEqual(legacy?.selectedEntry, { kind: 'revision', id: 'revision-1' });
  assert.equal(legacy?.initialView, 'history', 'legacy revision navigation is unchanged');

  await act(async () => root.unmount());
  console.log('File-change chat actions preserve exact graph/legacy review targets and explicit successor choice.');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
