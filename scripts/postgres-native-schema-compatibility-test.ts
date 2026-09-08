import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { account, user } from '@/app/lib/db/schema';

function assertColumnType(table: typeof user, columnName: string, expected: string): void {
  const column = getTableConfig(table).columns.find((candidate) => candidate.name === columnName);
  assert.ok(column, `${columnName} must exist`);
  assert.equal(column.getSQLType(), expected, `${columnName} must retain its physical PostgreSQL type`);
}

assertColumnType(user, 'email_verified', 'bigint');
assertColumnType(user, 'created_at', 'bigint');
assertColumnType(account, 'account_id', 'text');
assertColumnType(account, 'created_at', 'bigint');
assert.equal((user as { [key: symbol]: unknown })[Symbol.for('drizzle:Name')], 'user');
assert.equal((account as { [key: symbol]: unknown })[Symbol.for('drizzle:Name')], 'account');
console.log('native PostgreSQL schema compatibility tests passed');
