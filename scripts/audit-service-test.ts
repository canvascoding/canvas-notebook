import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-audit-service-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;

  await fs.mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  runMigrations(sqlite);
  sqlite.close();

  const { hashAuditValue, recordAuditEvent } = await import('../app/lib/audit/audit-service');
  const event = await recordAuditEvent({
    organizationId: 'org-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    sessionId: 'session-1',
    agentId: 'canvas-agent',
    source: 'test',
    eventType: 'security',
    entityType: 'integration_secret',
    entityId: 'secret-ref-1',
    action: 'integration_secret.update',
    status: 'success',
    metadata: {
      safePath: 'workspaces/team/org-1/files/report.md',
      apiKey: 'must-not-leak',
      nested: {
        refreshToken: 'must-not-leak-either',
      },
    },
    input: { value: 'input', password: 'hidden' },
    output: { value: 'output', accessToken: 'hidden' },
  });

  assert.ok(event?.id);

  const verifyDb = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    const rows = verifyDb.prepare('SELECT * FROM audit_events').all() as Array<{
      source: string;
      action: string;
      metadata_json: string;
      input_hash: string;
      output_hash: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'test');
    assert.equal(rows[0].action, 'integration_secret.update');
    assert.equal(rows[0].input_hash, hashAuditValue({ value: 'input', password: 'hidden' }));
    assert.equal(rows[0].output_hash, hashAuditValue({ value: 'output', accessToken: 'hidden' }));
    assert.doesNotMatch(rows[0].metadata_json, /must-not-leak/);
    assert.match(rows[0].metadata_json, /\[REDACTED\]/);
    assert.ok(rows[0].metadata_json.length <= 4096);
  } finally {
    verifyDb.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('Audit service test passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
