import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { AnyPgTable } from 'drizzle-orm/pg-core';
import { account, oauthClient, piSessions, user } from '@/app/lib/db/schema';
import { createTableSql } from '@/app/lib/db/postgres';

function assertColumnType(table: AnyPgTable, columnName: string, expected: string): void {
  const column = getTableConfig(table).columns.find((candidate) => candidate.name === columnName);
  assert.ok(column, `${columnName} must exist`);
  assert.equal(column.getSQLType(), expected, `${columnName} must retain its physical PostgreSQL type`);
}

assertColumnType(user, 'email_verified', 'bigint');
assertColumnType(user, 'created_at', 'bigint');
assertColumnType(account, 'account_id', 'text');
assertColumnType(account, 'created_at', 'bigint');
const drizzleName = Symbol.for('drizzle:Name');
assert.equal(Reflect.get(user, drizzleName), 'user');
assert.equal(Reflect.get(account, drizzleName), 'account');
assert.match(createTableSql(piSessions), /"id" bigserial PRIMARY KEY/);
const oauthClientSql = createTableSql(oauthClient);
assert.match(oauthClientSql, /"scopes" text/);
assert.match(oauthClientSql, /"contacts" text/);
const userSql = createTableSql(user);
assert.match(userSql, /"email_verified" bigint/);
assert.match(userSql, /"created_at" bigint/);
console.log('native PostgreSQL schema compatibility tests passed');
