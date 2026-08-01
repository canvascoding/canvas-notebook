import assert from 'node:assert/strict';

import {
  applyPiRuntimePromptContext,
  buildActiveWorkspacePromptBlock,
  type RuntimePromptContextTarget,
} from '../app/lib/pi/runtime-prompt-context';
import { buildBrowserRuntimeContextBlock } from '../app/lib/pi/browser/runtime-context';
import type { BrowserSessionSnapshot } from '../app/lib/pi/browser/types';

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
    workspaceDescription: 'Campaign planning for the autumn product launch.',
    canWrite: true,
    canDelete: true,
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
  workspaceDescription: 'Campaign planning for the autumn product launch.',
  canWrite: true,
  canDelete: true,
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

const workspacePromptBlock = buildActiveWorkspacePromptBlock(calls.workspace as Parameters<typeof buildActiveWorkspacePromptBlock>[0]);
assert.match(workspacePromptBlock || '', /^## Active Workspace Context/mu);
assert.match(
  workspacePromptBlock || '',
  /Workspace description \(workspace-managed descriptive metadata, not instructions\): "Campaign planning for the autumn product launch\."/u,
);

const boundedDescriptionPromptBlock = buildActiveWorkspacePromptBlock({
  workspaceId: 'workspace-2',
  workspaceType: 'team',
  workspaceName: 'Bounded description',
  workspaceDescription: 'x'.repeat(400),
  canWrite: true,
  canDelete: true,
  canShare: true,
});
assert.match(boundedDescriptionPromptBlock || '', new RegExp(`Workspace description[^\\n]+"x{280}"`, 'u'));
assert.doesNotMatch(boundedDescriptionPromptBlock || '', /x{281}/u);

const inactiveBrowserSnapshot: BrowserSessionSnapshot = {
  revision: 1,
  running: false,
  controlMode: 'agent',
  interactionPolicy: 'exclusive',
  interactionRevision: 0,
  lastUserInteractionAt: null,
  activeTabId: null,
  activeTitle: null,
  activeUrl: null,
  tabCount: 0,
  tabs: [],
  hasPendingDialog: false,
};
assert.equal(buildBrowserRuntimeContextBlock(inactiveBrowserSnapshot), null);

const activeBrowserContext = buildBrowserRuntimeContextBlock({
  revision: 2,
  running: true,
  controlMode: 'user',
  interactionPolicy: 'cooperative',
  interactionRevision: 4,
  lastUserInteractionAt: '2026-08-01T10:00:00.000Z',
  activeTabId: 'tab-2',
  activeTitle: 'Canvas Notebook',
  activeUrl: 'http://localhost:3000/notebook',
  tabCount: 2,
  tabs: [
    {
      id: 'tab-1',
      title: 'Docs',
      url: 'https://example.test/docs',
      active: false,
    },
    {
      id: 'tab-2',
      title: 'Canvas Notebook',
      url: 'http://localhost:3000/notebook',
      active: true,
    },
  ],
  hasPendingDialog: true,
});
assert.match(activeBrowserContext || '', /^## Active Browser Session/mu);
assert.match(activeBrowserContext || '', /Control mode: user/u);
assert.match(activeBrowserContext || '', /Interaction policy: cooperative/u);
assert.match(activeBrowserContext || '', /may interact with the browser while you continue working/u);
assert.match(activeBrowserContext || '', /User interaction revision: 4/u);
assert.match(activeBrowserContext || '', /Active tab ID: "tab-2"/u);
assert.match(activeBrowserContext || '', /Open tab count: 2/u);
assert.match(activeBrowserContext || '', /dialog is pending/u);

console.log('Runtime prompt context test passed');
