import assert from 'node:assert/strict';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

import { prepareMessagesForEffectiveModel } from '../app/lib/pi/multimodal-preparation';
import {
  projectAgentEventForExternal,
  projectAgentMessageForPersistence,
} from '../app/lib/pi/visual-data-projection';

const visionModel = {
  id: 'vision-test',
  name: 'Vision test',
  provider: 'test',
  api: 'openai-completions',
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
} as unknown as Model<'openai-completions'>;

const textModel = {
  ...visionModel,
  id: 'text-test',
  input: ['text'],
} as Model<'openai-completions'>;

async function main() {
  const imageData = Buffer.from('read-tool-image').toString('base64');
  const toolResult = {
    role: 'toolResult',
    toolCallId: 'read-1',
    toolName: 'read',
    content: [
      { type: 'text', text: 'Read image.png' },
      { type: 'image', data: imageData, mimeType: 'image/png' },
    ],
    details: {
      filePath: 'image.png',
      resolvedPath: '/private/workspace/image.png',
      type: 'image',
    },
    timestamp: Date.now(),
  } as unknown as AgentMessage;

  const visionPayload = await prepareMessagesForEffectiveModel([toolResult], visionModel);
  const visionContent = visionPayload[0].content as Array<{ type: string; data?: string }>;
  assert.equal(visionContent.filter((part) => part.type === 'image').length, 1);
  assert.equal(visionContent.find((part) => part.type === 'image')?.data, imageData);

  const textPayload = await prepareMessagesForEffectiveModel([toolResult], textModel);
  const textContent = textPayload[0].content as Array<{ type: string; text?: string }>;
  assert.equal(textContent.filter((part) => part.type === 'image').length, 0);
  assert.match(textContent.map((part) => part.text || '').join('\n'), /does not support vision/i);

  const persisted = projectAgentMessageForPersistence(toolResult);
  const persistedJson = JSON.stringify(persisted);
  assert.doesNotMatch(persistedJson, new RegExp(imageData));
  assert.doesNotMatch(persistedJson, /private\/workspace/);
  assert.match(persistedJson, /omitted from persisted chat history/);

  const external = projectAgentEventForExternal({
    type: 'tool_execution_end',
    result: toolResult,
  });
  const externalJson = JSON.stringify(external);
  assert.doesNotMatch(externalJson, new RegExp(imageData));
  assert.doesNotMatch(externalJson, /private\/workspace/);
  assert.match(externalJson, /omitted from live event/);

  console.log('[PI Multimodal Delivery Test] Passed.');
}

void main();
