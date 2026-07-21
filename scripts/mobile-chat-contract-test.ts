import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';

const sqlite = new Database(':memory:');
try {
  runMigrations(sqlite);
  runMigrations(sqlite);
  const columns = sqlite.prepare('PRAGMA table_info(pi_sessions)').all() as { name: string }[];
  assert.equal(columns.some((column) => column.name === 'archived_at'), true);
  const indexes = sqlite.prepare('PRAGMA index_list(pi_sessions)').all() as { name: string }[];
  assert.equal(indexes.some((index) => index.name === 'idx_pi_sessions_user_workspace_archived'), true);
} finally {
  sqlite.close();
}

const root = process.cwd();
const listRoute = readFileSync(path.join(root, 'app/api/mobile/v1/sessions/route.ts'), 'utf8');
const sessionRoute = readFileSync(path.join(root, 'app/api/mobile/v1/sessions/[sessionId]/route.ts'), 'utf8');
const attachmentRoute = readFileSync(path.join(root, 'app/api/mobile/v1/sessions/[sessionId]/attachments/route.ts'), 'utf8');
const service = readFileSync(path.join(root, 'app/lib/mobile/chat.ts'), 'utf8');
assert.match(listRoute, /query:\s*url\.searchParams\.get\('query'\)/u);
assert.match(listRoute, /archived:\s*url\.searchParams\.get\('archived'\) === 'true'/u);
assert.match(sessionRoute, /updateMobileChatSession/u);
assert.match(attachmentRoute, /requireMobileChatSession/u);
assert.match(attachmentRoute, /MAX_ATTACHMENT_BYTES/u);
assert.match(service, /isNull\(piSessions\.archivedAt\)/u);
assert.match(service, /isNotNull\(piSessions\.archivedAt\)/u);
assert.match(service, /SESSION_ACTIVE/u);
assert.match(service, /extractMessageAttachments/u);
assert.match(service, /extractPiMessageText\(piMessage, \{ hideAttachmentMetadata: true \}\)/u);
assert.match(service, /safeRelativeUrl/u);

console.log('mobile-chat-contract-test: ok');
