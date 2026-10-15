import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';

type Message = { role: string; content?: unknown; tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
export type ObservedToolResult = { id: string; name: string; content: unknown };
export type OwnedModelStep = (results: readonly ObservedToolResult[]) => {
  name: string; arguments: Record<string, unknown>;
};
type Turn = { marker: string; done: string; steps: readonly OwnedModelStep[]; issued: Array<{
  id: string; name: string; arguments: string;
}>; results: ObservedToolResult[]; completed: boolean };

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => item && typeof item === 'object'
    && typeof item.text === 'string' ? item.text : '').join('\n');
  return '';
}

/** Real HTTP/SSE transport; only the model's choice of next tool is deterministic. */
export async function startOwnedAgentToolModel(model: string) {
  assert.match(model, /^owned-sandbox-[a-f0-9]{16}$/u);
  let origin = '', turn: Turn | undefined, busy = false, verificationProbes = 0, requestCount = 0;
  const markers = new Set<string>();
  const outcomes: Array<{ marker: string; completed: boolean; tools: Array<{ id: string; name: string; argumentsHash: string }> }> = [];
  const failures: string[] = [];
  const server = http.createServer(async (request, response) => {
    const fail = (status: number, code: string) => {
      if (failures.length < 32) failures.push(code);
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: { message: code, type: 'owned_fixture_error' } }));
    };
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
      || request.headers.host !== new URL(origin).host) return fail(404, 'unsupported_request');
    if (busy || ++requestCount > 128) return fail(409, 'request_budget_or_overlap');
    busy = true;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) return fail(413, 'request_too_large');
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: unknown; stream?: unknown; messages?: Message[];
        tools?: Array<{ type: string; function: { name: string } }>;
      };
      if (input.model !== model || !Array.isArray(input.messages) || input.messages.length > 512) {
        return fail(400, 'unexpected_model_or_messages');
      }
      let next: Turn['issued'][number] | undefined;
      let content = 'OK';
      if (!turn) {
        if (++verificationProbes > 8) return fail(409, 'verification_budget');
      } else {
        const active = turn;
        if (active.completed) return fail(409, 'completed_turn_replay');
        const userIndex = input.messages.findLastIndex(message => message.role === 'user');
        if (userIndex < 0 || !messageText(input.messages[userIndex].content).includes(active.marker)) {
          return fail(409, 'unbound_user_turn');
        }
        const tail = input.messages.slice(userIndex + 1);
        if (tail.length !== active.issued.length * 2
          || active.results.length !== Math.max(0, active.issued.length - 1)) {
          return fail(409, 'missing_or_replayed_tool_result');
        }
        for (const [index, issued] of active.issued.entries()) {
          const assistant = tail[index * 2], returned = tail[index * 2 + 1];
          if (assistant.role !== 'assistant' || assistant.tool_calls?.length !== 1 || returned.role !== 'tool') {
            return fail(409, 'tool_result_order_changed');
          }
          const echoed = assistant.tool_calls[0];
          if (returned.tool_call_id !== issued.id || echoed.id !== issued.id
            || echoed.type !== 'function' || echoed.function.name !== issued.name
            || echoed.function.arguments !== issued.arguments) return fail(409, 'tool_result_identity_changed');
          const accepted = active.results[index];
          if (accepted && !isDeepStrictEqual(returned.content, accepted.content)) {
            return fail(409, 'accepted_tool_result_changed');
          }
        }
        if (active.issued.length) {
          const issued = active.issued.at(-1)!;
          active.results.push({ id: issued.id, name: issued.name, content: structuredClone(tail.at(-1)!.content) });
        }
        if (active.issued.length < active.steps.length) {
          const step = active.steps[active.issued.length](structuredClone(active.results));
          if (!input.tools?.some(tool => tool.type === 'function' && tool.function.name === step.name)) {
            return fail(409, 'required_tool_not_available');
          }
          const args = JSON.stringify(step.arguments);
          if (Buffer.byteLength(args) > 64 * 1024) return fail(413, 'arguments_too_large');
          next = { id: `call_${randomUUID().replaceAll('-', '')}`, name: step.name, arguments: args };
          active.issued.push(next);
        } else { active.completed = true; content = active.done; }
      }
      const common = { id: `owned-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model };
      const calls = next ? [{ index: 0, id: next.id, type: 'function', function: { name: next.name, arguments: next.arguments } }] : undefined;
      const finish = next ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (input.stream === true) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0,
          delta: { role: 'assistant', ...(calls ? { tool_calls: calls } : { content }) }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0,
          delta: {}, finish_reason: finish }], usage })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0,
          message: { role: 'assistant', content: next ? null : content,
            ...(calls ? { tool_calls: calls.map(({ index: _index, ...call }) => call) } : {}) }, finish_reason: finish }], usage }));
      }
    } catch { if (!response.headersSent) fail(400, 'fixture_protocol_failure'); else response.destroy(); }
    finally { busy = false; }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  let closed: Promise<void> | undefined;
  const record = () => {
    if (!turn) return;
    outcomes.push({ marker: turn.marker, completed: turn.completed, tools: turn.issued.map(item => ({
      id: item.id, name: item.name, argumentsHash: createHash('sha256').update(item.arguments).digest('hex'),
    })) });
  };
  return {
    origin, model,
    arm(marker: string, steps: readonly OwnedModelStep[]) {
      assert(!closed && !busy && (!turn || turn.completed), 'The prior real model turn must have completed.');
      assert.match(marker, /^OWNED_SANDBOX_[a-f0-9]{16}_[a-z0-9_-]{1,48}$/u);
      assert(!markers.has(marker) && markers.size < 32 && steps.length >= 1 && steps.length <= 8);
      record(); markers.add(marker);
      turn = { marker, done: `${marker}_DONE`, steps: [...steps], issued: [], results: [], completed: false };
      return turn.done;
    },
    evidence() {
      return { verificationProbes, requestCount, failures: [...failures], outcomes: structuredClone(outcomes),
        active: turn ? { marker: turn.marker, completed: turn.completed,
          issued: turn.issued.map(item => ({ id: item.id, name: item.name })), results: structuredClone(turn.results) } : null };
    },
    close() {
      closed ??= (async () => {
        record(); server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        assert.equal(server.listening, false);
      })();
      return closed;
    },
  };
}
