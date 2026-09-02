import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrateSqliteMainAgentId } from '../app/lib/db/main-agent-id-migration';

function main(): void {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL
    );
    CREATE TABLE pi_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL DEFAULT 'canvas-agent' REFERENCES agents(agent_id)
    );
    CREATE TABLE actor_events (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL DEFAULT 'canvas-agent'
    );
    INSERT INTO agents (agent_id, name, type)
    VALUES ('canvas-agent', 'Bradley', 'main');
    INSERT INTO pi_sessions (id) VALUES ('legacy-session');
    INSERT INTO actor_events (id) VALUES ('legacy-event');
  `);

  migrateSqliteMainAgentId(sqlite);

  assert.deepEqual(
    sqlite.prepare('SELECT agent_id, type FROM agents').all(),
    [{ agent_id: 'bradley', type: 'main' }],
  );
  assert.equal(
    sqlite.prepare("SELECT agent_id FROM pi_sessions WHERE id = 'legacy-session'").pluck().get(),
    'bradley',
  );
  assert.equal(
    sqlite.prepare("SELECT actor_id FROM actor_events WHERE id = 'legacy-event'").pluck().get(),
    'bradley',
  );

  for (const tableName of ['pi_sessions', 'actor_events']) {
    const columns = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
      dflt_value: string | null;
      name: string;
    }>;
    const identityColumn = columns.find((column) => (
      column.name === 'agent_id' || column.name === 'actor_id'
    ));
    assert.equal(identityColumn?.dflt_value, "'bradley'", `${tableName} default`);
  }

  sqlite.prepare('INSERT INTO pi_sessions (id) VALUES (?)').run('canonical-session');
  sqlite.prepare('INSERT INTO actor_events (id) VALUES (?)').run('canonical-event');
  assert.equal(
    sqlite.prepare("SELECT agent_id FROM pi_sessions WHERE id = 'canonical-session'").pluck().get(),
    'bradley',
  );
  assert.equal(
    sqlite.prepare("SELECT actor_id FROM actor_events WHERE id = 'canonical-event'").pluck().get(),
    'bradley',
  );

  const integrity = sqlite.pragma('integrity_check', { simple: true });
  assert.equal(integrity, 'ok');
  sqlite.close();
  console.log('bradley-agent-id-sqlite-migration-test: ok');
}

main();
