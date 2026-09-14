import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

test('the editor normal flow cannot mount an operation-scoped direct-edit grant control', async () => {
  const source = await fs.readFile('app/components/editor/CollaborationAgentOperations.tsx', 'utf8');
  assert.doesNotMatch(source, /CollaborationAgentDirectEditGrant|direct-edit-grant/u);
  assert.doesNotMatch(source, /CollaborationAgentProposalPreview|agentAccept|agentReject/u);
  assert.match(source, /openVersionCenter/u);
});

test('mutating proposal actions remain owned by the global file version center', async () => {
  const actions = await fs.readFile('app/components/file-version-center/FileVersionActions.tsx', 'utf8');
  assert.match(actions, /controller\.accept/u);
  assert.match(actions, /controller\.reject/u);
  assert.match(actions, /reviewedProposalVersion/u);
});
