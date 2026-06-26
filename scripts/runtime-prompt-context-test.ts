import assert from 'node:assert/strict';

import {
  applyPiRuntimePromptContext,
  type RuntimePromptContextTarget,
} from '../app/lib/pi/runtime-prompt-context';

function createTarget() {
  const calls: Record<string, unknown> = {};
  const target: RuntimePromptContextTarget = {
    setChannelContext: (value) => { calls.channelId = value; },
    setTimeZoneContext: (timeZone, currentTime) => {
      calls.timeZone = timeZone;
      calls.currentTime = currentTime;
    },
    setActiveFileContext: (value) => { calls.activeFilePath = value; },
    setPlanningMode: (value) => { calls.planningMode = value; },
    setPageContext: (value) => { calls.currentPage = value; },
    setStudioContext: (value) => { calls.studioContext = value; },
    setEmailContext: (value) => { calls.emailContext = value; },
    setWorkspaceContext: (value) => { calls.workspace = value; },
  };

  return { calls, target };
}

const emailContext = {
  accountEmail: 'agent@example.test',
  accountId: 'account-1',
  filter: 'unread' as const,
  folder: 'INBOX',
  folderName: 'Inbox',
  query: 'invoice',
  selectedMessageDate: '2026-06-26T10:00:00.000Z',
  selectedMessageFolder: 'INBOX',
  selectedMessageFrom: 'sender@example.test',
  selectedMessageId: 'message-1',
  selectedMessageIsRead: false,
  selectedMessageSubject: 'Invoice follow-up',
};

const { calls, target } = createTarget();
applyPiRuntimePromptContext(target, {
  channelId: 'web',
  userTimeZone: 'Europe/Berlin',
  currentTime: '2026-06-26T12:00:00.000Z',
  activeFilePath: '/data/workspaces/demo/file.md',
  planningMode: true,
  currentPage: '/emails',
  emailContext,
  studioContext: {
    generationId: 'studio-gen-1',
    outputFilePath: 'studio/outputs/image.png',
  },
  workspace: {
    workspaceId: 'workspace-1',
    workspaceType: 'personal',
    workspaceName: 'Personal',
    canWrite: true,
    canShare: false,
  },
});

assert.equal(calls.channelId, 'web');
assert.equal(calls.timeZone, 'Europe/Berlin');
assert.equal(calls.currentTime, '2026-06-26T12:00:00.000Z');
assert.equal(calls.activeFilePath, '/data/workspaces/demo/file.md');
assert.equal(calls.planningMode, true);
assert.equal(calls.currentPage, '/emails');
assert.deepEqual(calls.emailContext, emailContext);
assert.deepEqual(calls.studioContext, {
  generationId: 'studio-gen-1',
  outputFilePath: 'studio/outputs/image.png',
});
assert.deepEqual(calls.workspace, {
  workspaceId: 'workspace-1',
  workspaceType: 'personal',
  workspaceName: 'Personal',
  canWrite: true,
  canShare: false,
});

const { calls: emptyCalls, target: emptyTarget } = createTarget();
applyPiRuntimePromptContext(emptyTarget);

assert.equal(emptyCalls.channelId, undefined);
assert.equal(emptyCalls.activeFilePath, null);
assert.equal(emptyCalls.planningMode, false);
assert.equal(emptyCalls.currentPage, undefined);
assert.equal(emptyCalls.emailContext, undefined);
assert.equal(emptyCalls.studioContext, undefined);
assert.equal(emptyCalls.workspace, undefined);
assert.equal(emptyCalls.timeZone, undefined);

console.log('Runtime prompt context test passed');
