import assert from 'node:assert/strict';

import {
  readEmailAiDraftStream,
  readEmailSummaryStream,
} from '../app/lib/email/client-ai-stream';

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status, headers: { 'Content-Type': 'text/event-stream' } });
}

async function main() {
  const summaryDeltas: string[] = [];
  const summaryStatuses: string[] = [];
  const summary = await readEmailSummaryStream(streamResponse([
    'data: {"type":"start","messageId":"m-1"}\n\n',
    'data: {"type":"status","stage":"reading_context","label":"Reading"}\n\n',
    'data: {"type":"delta","delta":"First "}\n',
    '\ndata: {"type":"delta","delta":"summary"}\n\n',
    'data: {"type":"done","summary":"First summary"}\n\n',
  ]), (delta) => summaryDeltas.push(delta), (stage, label) => summaryStatuses.push(`${stage}:${label}`));

  assert.equal(summary, 'First summary');
  assert.deepEqual(summaryDeltas, ['First ', 'summary']);
  assert.deepEqual(summaryStatuses, ['reading_context:Reading']);

  const draftBodies: string[] = [];
  const draft = await readEmailAiDraftStream(streamResponse([
    'data: {"type":"status","stage":"writing"}\n\n',
    'data: {"type":"delta","delta":"Hello"}\n\n',
    'data: {"type":"delta","delta":" world"}\n\n',
    'data: {"type":"done"}\n\n',
  ]), { onDelta: (_delta, body) => draftBodies.push(body) });

  assert.equal(draft, 'Hello world');
  assert.deepEqual(draftBodies, ['Hello', 'Hello world']);

  await assert.rejects(
    () => readEmailSummaryStream(new Response(JSON.stringify({ error: 'Summary unavailable' }), { status: 503 }), () => undefined),
    /Summary unavailable/u,
  );
  await assert.rejects(
    () => readEmailAiDraftStream(streamResponse(['data: {"type":"error","message":"Draft failed"}\n\n'])),
    /Draft failed/u,
  );

  console.log('email-client-ai-stream-test: ok');
}

void main();
