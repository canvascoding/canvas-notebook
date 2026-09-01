import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { mobileToolCallId } from '../app/lib/mobile/tool-call-id';
import { formatMobileToolInput } from '../app/lib/mobile/tool-input';

const sqlite = new Database(':memory:');
try {
  runMigrations(sqlite);
  runMigrations(sqlite);
  const columns = sqlite.prepare('PRAGMA table_info(pi_sessions)').all() as { name: string }[];
  assert.equal(columns.some((column) => column.name === 'archived_at'), true);
  assert.equal(columns.some((column) => column.name === 'client_request_id'), true);
  const indexes = sqlite.prepare('PRAGMA index_list(pi_sessions)').all() as Array<{ name: string; unique: number }>;
  assert.equal(indexes.some((index) => index.name === 'idx_pi_sessions_user_workspace_archived'), true);
  assert.equal(indexes.find((index) => index.name === 'idx_pi_sessions_user_session')?.unique, 1);
  assert.equal(indexes.find((index) => index.name === 'idx_pi_sessions_user_client_request')?.unique, 1);
} finally {
  sqlite.close();
}

const root = process.cwd();
const listRoute = readFileSync(path.join(root, 'app/api/mobile/v1/sessions/route.ts'), 'utf8');
const sessionRoute = readFileSync(path.join(root, 'app/api/mobile/v1/sessions/[sessionId]/route.ts'), 'utf8');
const runtimeRoute = readFileSync(path.join(root, 'app/api/mobile/v1/sessions/[sessionId]/runtime/route.ts'), 'utf8');
const attachmentRoute = readFileSync(path.join(root, 'app/api/mobile/v1/sessions/[sessionId]/attachments/route.ts'), 'utf8');
const service = readFileSync(path.join(root, 'app/lib/mobile/chat.ts'), 'utf8');
const websocketServer = readFileSync(path.join(root, 'server/websocket-server.ts'), 'utf8');
assert.match(listRoute, /query:\s*url\.searchParams\.get\('query'\)/u);
assert.match(listRoute, /archived:\s*url\.searchParams\.get\('archived'\) === 'true'/u);
assert.match(listRoute, /error instanceof AiRuntimePolicyError/u);
assert.match(listRoute, /idempotency-key/u);
assert.match(listRoute, /clientRequestId: clientRequestIdFrom\(request\)/u);
assert.match(listRoute, /\{ success: false, code: error\.code, error: error\.message \}/u);
assert.match(sessionRoute, /updateMobileChatSession/u);
assert.match(sessionRoute, /markAsUnread:\s*typeof payload\.markAsUnread === 'boolean'/u);
assert.match(sessionRoute, /export async function GET/u);
assert.match(sessionRoute, /getMobileChatSession/u);
assert.match(service, /export async function getMobileChatSession/u);
assert.match(runtimeRoute, /getMobileChatRuntimeResolution/u);
assert.match(runtimeRoute, /updateMobileChatRuntimeSelection/u);
assert.match(runtimeRoute, /parseSessionRuntimeUpdate/u);
assert.match(runtimeRoute, /runtimeErrorResponse/u);
assert.match(attachmentRoute, /requireMobileChatSession/u);
assert.match(attachmentRoute, /MAX_ATTACHMENT_BYTES/u);
assert.match(attachmentRoute, /MAX_ATTACHMENTS = 4/u);
assert.match(attachmentRoute, /formData\.getAll\('file'\)/u);
assert.match(attachmentRoute, /attachment: attachments\[0\]/u);
assert.match(attachmentRoute, /attachments,/u);
assert.match(attachmentRoute, /normalizeUploadImageBuffer/u);
assert.match(service, /isNull\(piSessions\.archivedAt\)/u);
assert.match(service, /isNotNull\(piSessions\.archivedAt\)/u);
assert.match(service, /const activity = sql<number>`coalesce\(/u);
assert.match(service, /const activityAt = Math\.floor\(new Date\(cursor\.activityAt\)\.getTime\(\) \/ 1_000\);/u);
assert.match(service, /SESSION_ACTIVE/u);
assert.match(service, /PiSessionClientRequestConflictError/u);
assert.match(service, /clientRequestId: input\.clientRequestId/u);
assert.match(service, /markAsUnread\?: boolean/u);
assert.match(service, /input\.markAsUnread === true \? \{ lastViewedAt: null \}/u);
assert.match(service, /withRuntimeSessionOperation/u);
assert.match(service, /replaceSessionRuntimeSnapshot/u);
assert.match(service, /invalidateRuntime/u);
assert.match(service, /pi_session_runtime\.override/u);
assert.match(service, /extractMessageAttachments/u);
assert.match(service, /extractPiMessageText\(piMessage, \{ hideAttachmentMetadata: true \}\)/u);
assert.match(service, /mobileToolInputsById/u);
assert.match(service, /toolCallId,/u);
assert.match(service, /toolInput:/u);
assert.match(service, /safeRelativeUrl/u);
assert.match(websocketServer, /SESSION_DATA_CONFLICT/u);
assert.match(websocketServer, /conflicting session data/u);

const formattedToolInput = formatMobileToolInput({
  command: 'printf "hello"',
  nested: { target: 'Research/brief.md' },
  apiToken: 'top-secret-token',
  authorization: 'Bearer example-secret',
});
assert.match(formattedToolInput || '', /printf \\"hello\\"/u);
assert.match(formattedToolInput || '', /Research\/brief\.md/u);
assert.doesNotMatch(formattedToolInput || '', /top-secret-token|example-secret/u);
assert.match(formattedToolInput || '', /\[REDACTED\]/u);

assert.equal(mobileToolCallId({ role: 'toolResult', toolCallId: ' tool-call-qa ' }), 'tool-call-qa');
assert.equal(mobileToolCallId({ role: 'toolResult', toolCallId: '   ' }), null);
assert.equal(mobileToolCallId({ role: 'assistant' }), null);

console.log('mobile-chat-contract-test: ok');
