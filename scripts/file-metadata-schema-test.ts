import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';

const sqlite = new Database(':memory:');
runMigrations(sqlite);

for (const table of ['workspace_file_metadata', 'workspace_file_user_states']) {
  const result = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name?: string } | undefined;
  assert.equal(result?.name, table, `${table} must be created by migrations`);
}

sqlite.close();
console.log('File metadata schema tests passed');
