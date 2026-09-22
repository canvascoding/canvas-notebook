import assert from 'node:assert/strict';
import { createPromptHandoff, persistPromptHandoff, readPromptHandoff, consumePromptHandoff, isPromptHandoffForNavigation } from '../app/lib/chat/prompt-handoff';

const entries = new Map<string, string>();
const storage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => { entries.set(key, value); },
  removeItem: (key: string) => { entries.delete(key); },
};
const key = 'prompt';
const auth = { userId: 'user-one', sessionId: 'session-one' };
const payload = createPromptHandoff({ prompt: 'Review the plan', attachments: [],
  agentId: 'canvas-agent', workspaceId: 'workspace-one', auth });
persistPromptHandoff(storage, key, payload);
const context = { workspaceId: 'workspace-one', requestedHandoffId: payload.handoffId, auth };
assert.deepEqual(readPromptHandoff(storage, key, context), payload);
assert.equal(readPromptHandoff(storage, key, context)?.handoffId, payload.handoffId);
assert.throws(() => readPromptHandoff(storage, key, { ...context, workspaceId: 'workspace-two' }), /original workspace/);
assert.throws(() => readPromptHandoff(storage, key, { ...context, auth: { ...auth, sessionId: 'other' } }), /another sign-in/);
assert.throws(() => readPromptHandoff(storage, key, { ...context, requestedHandoffId: 'other' }), /does not match/);
const href = `?workspaceId=workspace-one&chat=open&handoff=${payload.handoffId}`;
assert.equal(isPromptHandoffForNavigation(storage, key, { search: href, workspaceId: 'workspace-one' }), true);
for (const search of ['', '?chat=open', '?session=other', `?path=plan.md&${href.slice(1)}`]) {
  assert.equal(isPromptHandoffForNavigation(storage, key, { search, workspaceId: 'workspace-one' }), false);
}
assert.equal(isPromptHandoffForNavigation(storage, key, { search: href, workspaceId: 'workspace-two' }), false);

const newer = createPromptHandoff({ ...payload, handoffId: 'newer' });
persistPromptHandoff(storage, key, newer);
consumePromptHandoff(storage, key, payload.handoffId);
assert.equal(readPromptHandoff(storage, key, { ...context, requestedHandoffId: 'newer' })?.handoffId, 'newer');
consumePromptHandoff(storage, key, 'newer');
assert.equal(storage.getItem(key), null);

storage.setItem(key, JSON.stringify({ prompt: 'Legacy request', attachments: [], agentId: 'canvas-agent' }));
assert.equal(isPromptHandoffForNavigation(storage, key, { search: '', workspaceId: 'workspace-one' }), true);
assert.equal(isPromptHandoffForNavigation(storage, key, { search: '?chat=open', workspaceId: 'workspace-one' }), false);
const upgraded = readPromptHandoff(storage, key, { workspaceId: 'workspace-one', auth })!;
assert.equal(upgraded.workspaceId, 'workspace-one');
assert.equal(readPromptHandoff(storage, key, { workspaceId: 'workspace-one', auth })?.handoffId, upgraded.handoffId);
assert.ok(upgraded.handoffId);
assert.throws(() => persistPromptHandoff({ ...storage, setItem: () => { throw new Error('Quota exceeded'); } }, key, payload), /Quota exceeded/);
assert.throws(() => persistPromptHandoff({ ...storage, setItem: () => {} }, key, payload), /could not be saved/);
console.log('chat prompt handoff tests passed');
