import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

async function main(): Promise<void> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-request-history-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataRoot;

  try {
    // Simulate the initial request-history release so this test also proves
    // that the version field is added safely on an existing instance volume.
    const legacyDatabase = new Database(path.join(dataRoot, 'sqlite.db'));
    legacyDatabase.exec(`
      CREATE TABLE direct_mcp_request_history (
        id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL,
        flow_ref TEXT,
        phase TEXT NOT NULL,
        http_method TEXT NOT NULL,
        operation TEXT,
        tool_name TEXT,
        outcome TEXT NOT NULL,
        status_code INTEGER,
        code TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    legacyDatabase.close();

    const { DIRECT_MCP_SERVER_VERSION } = await import(
      '../app/lib/mcp/server/version'
    );
    const {
      DIRECT_MCP_REQUEST_HISTORY_MAX_ENTRIES,
      recordDirectMcpRequestHistory,
      listRecentDirectMcpRequestHistory,
    } = await import('../app/lib/mcp/server/request-history');
    const now = new Date();

    await recordDirectMcpRequestHistory({
      requestId: 'request-safe',
      flowRef: 'a'.repeat(24),
      phase: 'oauth.registration',
      httpMethod: 'POST',
      operation: 'tools/call',
      toolName: 'upload_knowledge_asset',
      outcome: 'succeeded',
      statusCode: 201,
      code: 'OAUTH_REQUEST_COMPLETED',
      durationMs: 14,
      createdAt: now,
    });
    await recordDirectMcpRequestHistory({
      requestId: 'request-expired',
      phase: 'mcp.http',
      httpMethod: 'POST',
      outcome: 'failed',
      statusCode: 500,
      code: 'MCP_INTERNAL_ERROR',
      durationMs: 9,
      createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
    });

    let entries = await listRecentDirectMcpRequestHistory();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].requestId, 'request-safe');
    assert.equal(entries[0].serverVersion, DIRECT_MCP_SERVER_VERSION);
    assert.equal(entries[0].flowRef, 'a'.repeat(24));
    assert.equal(entries[0].phase, 'oauth.registration');
    assert.equal(entries[0].httpMethod, 'POST');
    assert.equal(entries[0].operation, 'tools/call');
    assert.equal(entries[0].toolName, 'upload_knowledge_asset');
    assert.equal(entries[0].outcome, 'succeeded');
    assert.equal(entries[0].statusCode, 201);
    assert.equal(entries[0].code, 'OAUTH_REQUEST_COMPLETED');
    assert.equal(entries[0].durationMs, 14);
    assert.equal(entries[0].createdAt.getTime(), Math.floor(now.getTime() / 1000) * 1000);

    for (let index = 0; index < DIRECT_MCP_REQUEST_HISTORY_MAX_ENTRIES + 5; index += 1) {
      await recordDirectMcpRequestHistory({
        requestId: `request-${index}`,
        phase: 'mcp.http',
        httpMethod: 'POST',
        operation: 'untrusted-operation',
        toolName: 'untrusted-tool-name',
        outcome: 'untrusted-outcome',
        statusCode: 200,
        code: 'untrusted-code',
        durationMs: -1,
        createdAt: new Date(now.getTime() + (index + 1) * 1000),
      });
    }

    entries = await listRecentDirectMcpRequestHistory();
    assert.equal(entries.length, DIRECT_MCP_REQUEST_HISTORY_MAX_ENTRIES);
    assert.equal(entries[0].requestId, `request-${DIRECT_MCP_REQUEST_HISTORY_MAX_ENTRIES + 4}`);
    assert.equal(entries.every((entry) => entry.operation === null), true);
    assert.equal(entries.every((entry) => entry.toolName === null), true);
    assert.equal(entries.every((entry) => entry.outcome === 'failed'), true);
    assert.equal(entries.every((entry) => entry.code === 'MCP_UNCLASSIFIED'), true);
    assert.equal(entries.every((entry) => entry.durationMs === 0), true);
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataRoot, { recursive: true, force: true });
  }

  console.log('mcp-server-request-history-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
