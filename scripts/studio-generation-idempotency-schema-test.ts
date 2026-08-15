import assert from 'node:assert/strict';

import Database from 'better-sqlite3';
import { runMigrations } from '../app/lib/db/migrate';

const sqlite = new Database(':memory:');
try {
  runMigrations(sqlite);

  const columns = sqlite.pragma('table_info(studio_generations)') as { name: string }[];
  assert.ok(columns.some((column) => column.name === 'idempotency_key'));

  const indexes = sqlite.pragma('index_list(studio_generations)') as { name: string; unique: number }[];
  const idempotencyIndex = indexes.find((index) => index.name === 'idx_studio_generations_idempotency');
  assert.ok(idempotencyIndex, 'the idempotency index must be created');
  assert.equal(idempotencyIndex.unique, 1);
} finally {
  sqlite.close();
}

console.log('Studio generation idempotency schema test passed.');
