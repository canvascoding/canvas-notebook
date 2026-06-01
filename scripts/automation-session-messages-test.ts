import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  buildPersistedAutomationMessages,
  getAutomationPersistedLength,
} from '../app/lib/automations/session-messages';

const existingUser: AgentMessage = {
  role: 'user',
  content: 'previous question',
  timestamp: 1,
};

const existingAssistant: AgentMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'previous answer' }],
  api: 'test',
  provider: 'test',
  model: 'test',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  stopReason: 'stop',
  timestamp: 2,
};

const promptMessage: AgentMessage = {
  role: 'user',
  content: 'AUTOMATION EXECUTION CONTEXT',
  timestamp: 3,
};

const automationAnswer: AgentMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'heartbeat result' }],
  api: 'test',
  provider: 'test',
  model: 'test',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  stopReason: 'stop',
  timestamp: 4,
};

const existingMessages = [existingUser, existingAssistant];

assert.deepEqual(
  buildPersistedAutomationMessages({
    existingMessages,
    promptMessage,
    runMessages: [promptMessage, automationAnswer],
  }),
  [existingUser, existingAssistant, promptMessage, automationAnswer],
);

assert.deepEqual(
  buildPersistedAutomationMessages({
    existingMessages,
    promptMessage,
    runMessages: [existingUser, existingAssistant, promptMessage, automationAnswer],
  }),
  [existingUser, existingAssistant, promptMessage, automationAnswer],
);

assert.deepEqual(
  buildPersistedAutomationMessages({
    existingMessages,
    promptMessage,
    runMessages: [automationAnswer],
  }),
  [existingUser, existingAssistant, promptMessage, automationAnswer],
);

assert.equal(
  getAutomationPersistedLength({
    existingMessagesLength: existingMessages.length,
    promptPersistedBeforeRun: true,
  }),
  existingMessages.length + 1,
);

assert.equal(
  getAutomationPersistedLength({
    existingMessagesLength: existingMessages.length,
    promptPersistedBeforeRun: false,
  }),
  existingMessages.length,
);

console.log('automation session message tests passed');
