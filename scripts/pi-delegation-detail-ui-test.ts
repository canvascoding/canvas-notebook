import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  fetchChatDelegationProgress,
  fetchChatDelegationSteeringReceipt,
  fetchChatDelegationTranscript,
  sendChatDelegationSteering,
} from '../app/lib/chat/delegation-api';

async function main() {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes('/progress?')) return Response.json({
      success: true,
      delegation: { id: 'task/one', workerSessionId: 'worker/one', status: 'running', displayStatus: 'running', leaseState: 'active', revision: 41 },
      events: [{ revision: 41, kind: 'tool_end', preview: 'read_file', createdAt: '2026-09-28T12:00:00Z' }],
      transcript: [],
    });
    if (url.startsWith('/api/sessions/messages?')) return Response.json({
      success: true,
      messages: [{ id: 7, sequence: 9, role: 'assistant', content: [{ type: 'text', text: 'Checked' }], createdAt: '2026-09-28T12:00:00Z' }],
      hasMoreBefore: true,
      oldestSequence: 9,
      oldestMessageId: 7,
    });
    if (url.includes('/steering?')) return Response.json({
      success: true,
      receipt: { id: 'receipt/one', delegationId: 'task/one', status: 'delivered', createdAt: '2026-09-28T12:00:00Z', deliveredAt: '2026-09-28T12:00:01Z', missedAt: null },
    });
    if (url.endsWith('/steering')) return Response.json({
      success: true,
      receipt: { id: 'receipt/one', delegationId: 'task/one', status: 'accepted', createdAt: '2026-09-28T12:00:00Z', deliveredAt: null, missedAt: null },
    });
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const progress = await fetchChatDelegationProgress({ id: 'task/one', sourceSessionId: 'parent/one', afterRevision: 40 });
    assert.equal(progress.events[0]?.revision, 41);
    assert.equal(requests[0]?.url, '/api/delegations/task%2Fone/progress?sourceSessionId=parent%2Fone&afterRevision=40&limit=100&tailLimit=0');

    const transcript = await fetchChatDelegationTranscript({
      id: 'task/one', workerSessionId: 'worker/one', agentId: 'agent/one', sourceSessionId: 'parent/one', beforeSequence: 12, beforeId: 14,
    });
    assert.equal(transcript.messages[0]?.sequence, 9);
    const transcriptQuery = new URL(requests[1]!.url, 'http://localhost').searchParams;
    assert.equal(transcriptQuery.get('sessionId'), 'worker/one');
    assert.equal(transcriptQuery.get('sourceSessionId'), 'parent/one');
    assert.equal(transcriptQuery.get('delegationId'), 'task/one');
    assert.equal(transcriptQuery.get('agentId'), 'agent/one');
    assert.equal(transcriptQuery.get('beforeSequence'), '12');
    assert.equal(transcriptQuery.get('beforeId'), '14');

    const accepted = await sendChatDelegationSteering({ id: 'task/one', sourceSessionId: 'parent/one', message: 'Check one more case', requestId: 'request-1' });
    assert.equal(accepted.status, 'accepted');
    assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
      sourceSessionId: 'parent/one', message: 'Check one more case', requestId: 'request-1',
    });
    const delivered = await fetchChatDelegationSteeringReceipt({ id: 'task/one', sourceSessionId: 'parent/one', receiptId: 'receipt/one' });
    assert.equal(delivered.status, 'delivered');
    assert.equal(new URL(requests[3]!.url, 'http://localhost').searchParams.get('receiptId'), 'receipt/one');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const panel = fs.readFileSync(path.join(process.cwd(), 'app/components/canvas-agent-chat/ChatDelegationPanel.tsx'), 'utf8');
  const detail = fs.readFileSync(path.join(process.cwd(), 'app/components/canvas-agent-chat/ChatDelegationDetail.tsx'), 'utf8');
  assert.match(panel, /id="chat-delegation-panel"/u);
  assert.match(panel, /data-delegation-id=\{task.id\}/u);
  assert.match(panel, /delegation-progress-\$\{task.id\}/u);
  assert.match(detail, /data-testid="delegation-detail"/u);
  assert.match(detail, /delegation-steer-\$\{task.id\}/u);
  console.log('pi-delegation-detail-ui-test: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
