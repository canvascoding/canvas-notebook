import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import type { Message, Model } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { startOwnedAgentToolModel } from '../tests/helpers/owned-agent-tool-model';

const id = '0123456789abcdef';
const modelId = `owned-sandbox-${id}`;

test('real Pi HTTP/SSE adapter retains tool IDs, arguments, results and final completion', { timeout: 15_000 }, async () => {
  const fixture = await startOwnedAgentToolModel(modelId);
  try {
    const model: Model<'openai-completions'> = { id: modelId, name: modelId, api: 'openai-completions', provider: 'ollama',
      baseUrl: `${fixture.origin}/v1`, reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const options = { apiKey: 'owned-fixture-only', maxTokens: 256, maxRetries: 0 };
    const probe = await completeSimple(model, { messages: [{ role: 'user', content: 'Reply OK', timestamp: 1 }] }, options);
    assert.equal(probe.stopReason, 'stop');
    assert.deepEqual(probe.content, [{ type: 'text', text: 'OK' }]);
    assert.equal(fixture.evidence().verificationProbes, 1);
    const marker = `OWNED_SANDBOX_${id}_real_sdk`;
    const done = fixture.arm(marker, [
      () => ({ name: 'inspect_document', arguments: { path: 'owned.md' } }),
      results => {
        assert.equal(results.length, 1);
        assert.equal(results[0].name, 'inspect_document');
        assert.equal(results[0].content, '{"version":7}');
        return { name: 'edit_document', arguments: { version: 7, text: 'äöü 😀' } };
      },
    ]);
    const tools = [
      { name: 'inspect_document', description: 'Fixture read', parameters: Type.Object({ path: Type.String() }) },
      { name: 'edit_document', description: 'Fixture edit', parameters: Type.Object({ version: Type.Number(), text: Type.String() }) },
    ];
    const messages: Message[] = [{ role: 'user', content: marker, timestamp: 2 }];
    const read = await completeSimple(model, { messages, tools }, options);
    assert.equal(read.stopReason, 'toolUse');
    const first = read.content.find(item => item.type === 'toolCall');
    assert.ok(first && first.type === 'toolCall');
    assert.equal(first.name, 'inspect_document'); assert.deepEqual(first.arguments, { path: 'owned.md' });
    messages.push(read, { role: 'toolResult', toolName: first.name, toolCallId: first.id, isError: false,
      content: [{ type: 'text', text: '{"version":7}' }], timestamp: 3 });
    const edit = await completeSimple(model, { messages, tools }, options);
    assert.equal(edit.stopReason, 'toolUse');
    const second = edit.content.find(item => item.type === 'toolCall');
    assert.ok(second && second.type === 'toolCall');
    assert.equal(second.name, 'edit_document'); assert.deepEqual(second.arguments, { version: 7, text: 'äöü 😀' });
    assert.notEqual(second.id, first.id);
    messages.push(edit, { role: 'toolResult', toolName: second.name, toolCallId: second.id, isError: false,
      content: [{ type: 'text', text: '{"persisted":true}' }], timestamp: 4 });
    const final = await completeSimple(model, { messages, tools }, options);
    assert.equal(final.stopReason, 'stop'); assert.deepEqual(final.content, [{ type: 'text', text: done }]);
    const evidence = fixture.evidence();
    assert.equal(evidence.active?.completed, true); assert.equal(evidence.active?.results.length, 2);
    assert.equal(evidence.requestCount, 4); assert.deepEqual(evidence.failures, []);
  } finally { await fixture.close(); await fixture.close(); }
  await assert.rejects(fetch(`${fixture.origin}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(1_000) }));
});

test('missing, replayed or foreign tool results cannot advance or duplicate the fixed plan', { timeout: 10_000 }, async () => {
  const fixture = await startOwnedAgentToolModel(modelId);
  const marker = `OWNED_SANDBOX_${id}_causality`;
  try {
    let builds = 0;
    fixture.arm(marker, [() => { builds++; return { name: 'edit_document', arguments: { text: 'once' } }; }]);
    const body = { model: modelId, stream: false, messages: [{ role: 'user', content: marker }],
      tools: [{ type: 'function', function: { name: 'edit_document' } }] };
    const send = (value: unknown, pathname = '/v1/chat/completions') => fetch(`${fixture.origin}${pathname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(3_000),
    });
    assert.equal((await send({ ...body, model: 'foreign-model' })).status, 400);
    assert.equal((await send(body, '/other')).status, 404);
    const response = await send(body); assert.equal(response.status, 200);
    const call = (await response.json()).choices[0].message.tool_calls[0];
    assert.equal(builds, 1);
    assert.equal((await send(body)).status, 409);
    assert.equal((await send({ ...body, messages: [...body.messages, { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: 'foreign-call', content: '{}' }] })).status, 409);
    assert.equal(builds, 1); assert.equal(fixture.evidence().active?.results.length, 0);
    const finish = await send({ ...body, messages: [...body.messages, { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: '{"applied":true}' }] });
    assert.equal(finish.status, 200); assert.equal(fixture.evidence().active?.completed, true);
    assert.equal(builds, 1);
    assert.equal((await send(body)).status, 409);
  } finally { await fixture.close(); }
});

test('a result preceding its assistant call cannot complete or poison the armed turn', { timeout: 10_000 }, async () => {
  const fixture = await startOwnedAgentToolModel(modelId);
  const marker = `OWNED_SANDBOX_${id}_result_before_call`;
  try {
    let builds = 0;
    const done = fixture.arm(marker, [() => { builds++; return { name: 'edit_document', arguments: { text: 'once' } }; }]);
    const body = { model: modelId, stream: false, messages: [{ role: 'user', content: marker }],
      tools: [{ type: 'function', function: { name: 'edit_document' } }] };
    const send = (messages: unknown[]) => fetch(`${fixture.origin}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, messages }),
      signal: AbortSignal.timeout(3_000),
    });
    const first = await send(body.messages); assert.equal(first.status, 200);
    const call = (await first.json()).choices[0].message.tool_calls[0];
    const assistant = { role: 'assistant', content: null, tool_calls: [call] };
    const result = { role: 'tool', tool_call_id: call.id, content: '{"applied":true}' };

    const reversed = await send([...body.messages, result, assistant]);
    assert.equal(reversed.status, 409, 'A known result ID does not authorize placing its result before the assistant call.');
    assert.equal(builds, 1);
    assert.equal(fixture.evidence().active?.completed, false);
    assert.deepEqual(fixture.evidence().active?.results, []);

    const ordered = await send([...body.messages, assistant, result]);
    assert.equal(ordered.status, 200, 'Rejecting an invalid transcript must preserve the valid pending call.');
    assert.equal((await ordered.json()).choices[0].message.content, done);
    assert.equal(fixture.evidence().active?.completed, true);
    assert.equal(fixture.evidence().active?.results.length, 1);
    assert.equal(builds, 1);
  } finally { await fixture.close(); }
});

test('a confirmed result prefix cannot change while returning the next issued call', { timeout: 10_000 }, async () => {
  const fixture = await startOwnedAgentToolModel(modelId);
  const marker = `OWNED_SANDBOX_${id}_changed_result_prefix`;
  try {
    let builds = 0;
    const done = fixture.arm(marker, [
      () => { builds++; return { name: 'inspect_document', arguments: { path: 'owned.md' } }; },
      results => {
        builds++;
        assert.equal(results.length, 1); assert.equal(results[0].content, '{"version":7}');
        return { name: 'edit_document', arguments: { version: 7, text: 'once' } };
      },
    ]);
    const body = { model: modelId, stream: false, messages: [{ role: 'user', content: marker }],
      tools: ['inspect_document', 'edit_document'].map(name => ({ type: 'function', function: { name } })) };
    const send = (messages: unknown[]) => fetch(`${fixture.origin}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, messages }),
      signal: AbortSignal.timeout(3_000),
    });
    const first = await send(body.messages); assert.equal(first.status, 200);
    const readCall = (await first.json()).choices[0].message.tool_calls[0];
    const readAssistant = { role: 'assistant', content: null, tool_calls: [readCall] };
    const readResult = { role: 'tool', tool_call_id: readCall.id, content: '{"version":7}' };
    const second = await send([...body.messages, readAssistant, readResult]); assert.equal(second.status, 200);
    const editCall = (await second.json()).choices[0].message.tool_calls[0];
    assert.deepEqual(JSON.parse(editCall.function.arguments), { version: 7, text: 'once' });
    const editAssistant = { role: 'assistant', content: null, tool_calls: [editCall] };
    const editResult = { role: 'tool', tool_call_id: editCall.id, content: '{"persisted":true}' };
    const confirmed = fixture.evidence().active!.results;
    assert.equal(confirmed.length, 1); assert.equal(builds, 2);

    const changed = await send([...body.messages, readAssistant, { ...readResult, content: '{"version":999}' }, editAssistant, editResult]);
    assert.equal(changed.status, 409, 'Accepted result content must remain bound to the already chosen dependent edit.');
    assert.equal(fixture.evidence().active?.completed, false);
    assert.deepEqual(fixture.evidence().active?.results, confirmed);
    assert.equal(builds, 2);

    const unchanged = await send([...body.messages, readAssistant, readResult, editAssistant, editResult]);
    assert.equal(unchanged.status, 200, 'The original confirmed prefix and current result must still complete.');
    assert.equal((await unchanged.json()).choices[0].message.content, done);
    assert.equal(fixture.evidence().active?.completed, true);
    assert.equal(fixture.evidence().active?.results.length, 2);
    assert.equal(builds, 2);
  } finally { await fixture.close(); }
});
