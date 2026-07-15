import assert from 'node:assert/strict';
import { completeCreatedWorkspaceItem } from '../app/lib/files/create-follow-up';

async function testCreatedFileUsesCorrelatedOpenFlow() {
  const calls: string[] = [];
  const result = await completeCreatedWorkspaceItem({
    path: 'notes/new.md',
    itemType: 'file',
    workspaceId: 'workspace-a',
    transitionId: 'create-transition',
    getActiveWorkspaceId: () => 'workspace-a',
    openFile: async (path, options) => {
      calls.push(`file:${path}:${options.workspaceId}:${options.transitionId}`);
      return { status: 'opened', path };
    },
    openDirectory: async () => {
      calls.push('directory');
    },
  });

  assert.deepEqual(result, { status: 'opened', path: 'notes/new.md' });
  assert.deepEqual(calls, ['file:notes/new.md:workspace-a:create-transition']);
}

async function testCreatedDirectoryStaysInExplorer() {
  const calls: string[] = [];
  const result = await completeCreatedWorkspaceItem({
    path: 'notes/new-folder',
    itemType: 'directory',
    workspaceId: 'workspace-a',
    transitionId: 'unused-transition',
    getActiveWorkspaceId: () => 'workspace-a',
    openFile: async (path) => {
      calls.push(`file:${path}`);
      return { status: 'opened', path };
    },
    openDirectory: async (path, workspaceId) => {
      calls.push(`directory:${path}:${workspaceId}`);
    },
  });

  assert.deepEqual(result, { status: 'directory-opened', path: 'notes/new-folder' });
  assert.deepEqual(calls, ['directory:notes/new-folder:workspace-a']);
}

async function testWorkspaceChangeSupersedesFollowUp() {
  let opened = false;
  const result = await completeCreatedWorkspaceItem({
    path: 'notes/new.md',
    itemType: 'file',
    workspaceId: 'workspace-a',
    transitionId: 'stale-transition',
    getActiveWorkspaceId: () => 'workspace-b',
    openFile: async (path) => {
      opened = true;
      return { status: 'opened', path };
    },
    openDirectory: async () => {
      opened = true;
    },
  });

  assert.deepEqual(result, { status: 'superseded', path: 'notes/new.md' });
  assert.equal(opened, false, 'a create completion from another workspace must not change the active UI');
}

async function main() {
  await testCreatedFileUsesCorrelatedOpenFlow();
  await testCreatedDirectoryStaysInExplorer();
  await testWorkspaceChangeSupersedesFollowUp();
  console.log('file-create-follow-up-test: ok');
}

void main();
