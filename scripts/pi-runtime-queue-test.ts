import assert from 'node:assert/strict';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  RuntimeMessageQueues,
  type RuntimeQueueEntry,
} from '../app/lib/pi/runtime-queue';

type QueueAgentSpy = {
  followUps: AgentMessage[];
  steering: AgentMessage[];
  clearFollowUps: number;
  clearSteering: number;
  followUp: (message: AgentMessage) => void;
  steer: (message: AgentMessage) => void;
  clearFollowUpQueue: () => void;
  clearSteeringQueue: () => void;
  clearAllQueues: () => void;
};

function createAgentSpy(): QueueAgentSpy {
  const spy: QueueAgentSpy = {
    followUps: [],
    steering: [],
    clearFollowUps: 0,
    clearSteering: 0,
    followUp: (message) => { spy.followUps.push(message); },
    steer: (message) => { spy.steering.push(message); },
    clearFollowUpQueue: () => {
      spy.clearFollowUps += 1;
      spy.followUps = [];
    },
    clearSteeringQueue: () => {
      spy.clearSteering += 1;
      spy.steering = [];
    },
    clearAllQueues: () => {
      spy.clearFollowUpQueue();
      spy.clearSteeringQueue();
    },
  };
  return spy;
}

function entry(
  id: string,
  text: string,
  timestamp: number,
  context?: RuntimeQueueEntry['context'],
): RuntimeQueueEntry {
  const message: Extract<AgentMessage, { role: 'user' }> = {
    role: 'user',
    content: text,
    timestamp,
  };
  return {
    id,
    preview: {
      id,
      text,
      attachmentCount: 0,
      messageTimestamp: timestamp,
      signature: `${timestamp}:${text}:0`,
    },
    message,
    signature: `${timestamp}:${text}:0`,
    context,
  };
}

function queuedTexts(messages: AgentMessage[]): string[] {
  return messages.map((message) => {
    assert.equal(message.role, 'user');
    const content = (message as Extract<AgentMessage, { role: 'user' }>).content;
    if (typeof content !== 'string') {
      throw new Error('Queue test expects text-only user messages.');
    }
    return content;
  });
}

const agent = createAgentSpy();
const queues = new RuntimeMessageQueues();
const keepQueued = entry('keep', 'keep queued', 1);
const selected = entry('selected', 'steer only this', 2);

queues.enqueueFollowUp(keepQueued, agent);
queues.enqueueFollowUp(selected, agent);
assert.deepEqual(queuedTexts(agent.followUps), ['keep queued']);

const promoted = queues.promoteFollowUp(selected.id, agent);
assert.equal(promoted, selected);
assert.equal(promoted?.context, undefined);
assert.deepEqual(queues.followUps, [keepQueued]);
assert.deepEqual(agent.followUps, []);

queues.enqueueSteering(promoted!, agent);
assert.deepEqual(queuedTexts(agent.steering), ['steer only this']);

const laterFollowUp = entry('later', 'also keep queued', 3);
queues.enqueueFollowUp(laterFollowUp, agent);
assert.deepEqual(queues.followUps, [keepQueued, laterFollowUp]);
assert.deepEqual(agent.followUps, []);

agent.steering.shift();
queues.consume(selected.signature, agent);
assert.deepEqual(queues.followUps, [keepQueued, laterFollowUp]);
assert.deepEqual(queuedTexts(agent.followUps), ['keep queued']);

const idleAgent = createAgentSpy();
const idleQueues = new RuntimeMessageQueues();
const idleKeepQueued = entry('idle-keep', 'keep queued while idle', 10);
const idleSelected = entry('idle-selected', 'start immediately while idle', 11);
idleQueues.enqueueFollowUp(idleKeepQueued, idleAgent);
idleQueues.enqueueFollowUp(idleSelected, idleAgent);

const idlePromoted = idleQueues.promoteFollowUp(idleSelected.id, idleAgent);
assert.equal(idlePromoted, idleSelected);
idleQueues.trackSteering(idlePromoted!);
assert.deepEqual(idleAgent.steering, []);

idleQueues.consume(idleSelected.signature, idleAgent);
assert.deepEqual(queuedTexts(idleAgent.followUps), ['keep queued while idle']);

const frozenContext = {
  activeFilePath: 'notes/active-at-send.md',
  notebookContext: {
    activeSurface: { kind: 'document' as const, path: 'notes/active-at-send.md' },
    chatPlacement: 'side' as const,
    openDocuments: [
      { path: 'notes/active-at-send.md', state: 'active' as const },
      { path: 'notes/background.md', state: 'background' as const },
    ],
  },
};
const contextEntry = entry('with-context', 'keep send-time context', 12, frozenContext);
idleQueues.enqueueFollowUp(contextEntry, idleAgent);
assert.equal(idleQueues.followUps.at(-1)?.context, frozenContext);

assert.equal(queues.remove(keepQueued.id, agent), 'follow_up');
assert.equal(queues.remove(laterFollowUp.id, agent), 'follow_up');

const resumedFollowUp = entry('resumed', 'queue normally again', 4);
queues.enqueueFollowUp(resumedFollowUp, agent);
assert.deepEqual(queuedTexts(agent.followUps), ['queue normally again']);

const automaticAgent = createAgentSpy();
const automaticQueues = new RuntimeMessageQueues();
const firstAutomatic = entry('first-auto', 'first automatic', 5);
const secondAutomatic = entry('second-auto', 'second automatic', 6);
automaticQueues.enqueueFollowUp(firstAutomatic, automaticAgent);
automaticQueues.enqueueFollowUp(secondAutomatic, automaticAgent);
assert.deepEqual(queuedTexts(automaticAgent.followUps), ['first automatic']);

// Agent-core removes the active entry before emitting message_start. The queue
// controller then releases exactly one following entry.
automaticAgent.followUps.shift();
automaticQueues.consume(firstAutomatic.signature, automaticAgent);
assert.deepEqual(queuedTexts(automaticAgent.followUps), ['second automatic']);

console.log('pi-runtime-queue-test: ok');
