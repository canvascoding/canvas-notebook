import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { agents, canvasDataMigrations } from '../app/lib/db/schema';
import { createTableSql, quotePostgresIdentifier } from '../app/lib/db/postgres';
import { MAIN_AGENT_ID_MIGRATION_KEY, migratePostgresMainAgentId } from '../app/lib/db/main-agent-id-migration';
import { LEGACY_MAIN_AGENT_ID, MAIN_AGENT_ID } from '../app/lib/agents/main-agent';

const ownSchema = 'own "agent" scope', otherSchema = 'other-agent-scope';
const qualified = (schema: string, table: string) => `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
const relations = [
  ['public', 'shared_refs'], ['public', 'public_only_refs'], [otherSchema, 'other_only_refs'],
  [ownSchema, 'shared_refs'], [ownSchema, 'own_only_refs'],
] as const;

async function fixture(publicFallback: boolean) {
  const database = new PGlite();
  try {
    await database.exec(`CREATE SCHEMA ${quotePostgresIdentifier(ownSchema)}; CREATE SCHEMA ${quotePostgresIdentifier(otherSchema)}`);
    for (const [schema, table] of relations) {
      await database.exec(`CREATE TABLE ${qualified(schema, table)} (
        id integer PRIMARY KEY,
        agent_id text NOT NULL DEFAULT 'canvas-agent',
        origin_agent_id character varying(64) NOT NULL DEFAULT 'canvas-agent',
        actor_id text NOT NULL DEFAULT 'canvas-agent',
        service_actor_id character varying(64) NOT NULL DEFAULT 'canvas-agent',
        unrelated_id text NOT NULL DEFAULT 'canvas-agent',
        numeric_agent_id bigint NOT NULL DEFAULT 17
      ); INSERT INTO ${qualified(schema, table)} (id) VALUES (1)`);
    }
    await database.exec(`SET search_path TO ${quotePostgresIdentifier(ownSchema)}, ${publicFallback ? 'public' : 'pg_catalog'}`);
    assert.equal((await database.query<{ current: string }>('SELECT current_schema() AS current')).rows[0].current, ownSchema);
    // Actual production table definitions preserve numeric agents fields and
    // the migration ledger contract; no mocked client rows or discovery exist.
    await database.exec(createTableSql(agents));
    await database.exec(`CREATE UNIQUE INDEX own_agent_identity ON agents(agent_id)`);
    await database.exec(createTableSql(canvasDataMigrations));
    await insertAgent(database, LEGACY_MAIN_AGENT_ID, 'main');
    return database;
  } catch (cause) { await database.close(); throw cause; }
}

async function insertAgent(database: PGlite, id: string, type: string) {
  await database.query(`INSERT INTO agents (
    agent_id,name,icon_id,type,removable,
    default_provider_installation_id,default_provider,default_model,default_thinking,
    enabled_tools_json,relevant_skills_json,relevant_connections_json,
    access_policy,scope_type,organization_id,owner_user_id,created_by_user_id,
    revision,created_at,updated_at
  ) VALUES ($1,'Preserved agent profile','custom-icon',$2,1,
    'provider-installation','test-provider','test-model','high',
    '["read","edit_file"]','["fixture-skill"]','["fixture-connection"]',
    'restricted','user','owned-organization','owned-user','creator-user',7,1700000000123,1700000000456)`, [id, type]);
}

async function foreignState(database: PGlite) {
  const rows = [];
  for (const [schema, table] of relations.filter(([schema]) => schema !== ownSchema)) {
    rows.push({ schema, table, rows: (await database.query(`SELECT * FROM ${qualified(schema, table)} ORDER BY id`)).rows });
  }
  const defaults = (await database.query(`SELECT table_schema,table_name,column_name,column_default
    FROM information_schema.columns WHERE table_schema=ANY($1::text[])
      AND table_name=ANY($2::text[]) ORDER BY table_schema,table_name,ordinal_position`,
  [['public', otherSchema], relations.map(([, table]) => table)])).rows;
  return { rows, defaults };
}

async function ownState(database: PGlite) {
  const rows = [];
  for (const [, table] of relations.filter(([schema]) => schema === ownSchema)) {
    rows.push({ table, rows: (await database.query(`SELECT * FROM ${qualified(ownSchema, table)} ORDER BY id`)).rows });
  }
  return { rows, agents: (await database.query('SELECT * FROM agents ORDER BY agent_id')).rows,
    migrations: (await database.query('SELECT * FROM canvas_data_migrations ORDER BY migration_key')).rows,
    defaults: (await database.query(`SELECT table_name,column_name,column_default FROM information_schema.columns
      WHERE table_schema=$1 ORDER BY table_name,ordinal_position`, [ownSchema])).rows };
}

async function verifyMigratedOwnState(database: PGlite, originalAgent: Record<string, unknown>) {
  const profiles = (await database.query<Record<string, unknown>>('SELECT * FROM agents ORDER BY agent_id')).rows;
  assert.equal(profiles.length, 1); assert.equal(profiles[0].agent_id, MAIN_AGENT_ID);
  assert.notEqual(profiles[0].id, originalAgent.id, 'The canonical agent is a real inserted row.');
  const profile = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !['id', 'agent_id'].includes(key)));
  assert.deepEqual(profile(profiles[0]), profile(originalAgent), 'Every copied persisted profile value must remain exact.');
  assert.equal(Number(profiles[0].removable), 1); assert.equal(Number(profiles[0].revision), 7);
  assert.equal(Number(profiles[0].created_at), 1700000000123); assert.equal(Number(profiles[0].updated_at), 1700000000456);
  for (const [, table] of relations.filter(([schema]) => schema === ownSchema)) {
    const entries = (await database.query<Record<string, unknown>>(`SELECT * FROM ${qualified(ownSchema, table)} ORDER BY id`)).rows;
    assert.equal(entries.length, 1);
    for (const column of ['agent_id', 'origin_agent_id', 'actor_id', 'service_actor_id']) assert.equal(entries[0][column], MAIN_AGENT_ID);
    assert.equal(entries[0].unrelated_id, LEGACY_MAIN_AGENT_ID); assert.equal(Number(entries[0].numeric_agent_id), 17);
    // Exercise the actual ALTER DEFAULT, rather than checking SQL spelling.
    await database.query(`INSERT INTO ${qualified(ownSchema, table)} (id) VALUES (2)`);
    const inserted = (await database.query<Record<string, unknown>>(`SELECT * FROM ${qualified(ownSchema, table)} WHERE id=2`)).rows[0];
    for (const column of ['agent_id', 'origin_agent_id', 'actor_id', 'service_actor_id']) assert.equal(inserted[column], MAIN_AGENT_ID);
    assert.equal(inserted.unrelated_id, LEGACY_MAIN_AGENT_ID); assert.equal(Number(inserted.numeric_agent_id), 17);
  }
  const ledger = (await database.query<Record<string, unknown>>('SELECT * FROM canvas_data_migrations')).rows;
  assert.equal(ledger.length, 1); assert.equal(ledger[0].migration_key, MAIN_AGENT_ID_MIGRATION_KEY);
  assert(Number(ledger[0].completed_at) > 0);
  assert.deepEqual(JSON.parse(String(ledger[0].metadata_json)), { from: LEGACY_MAIN_AGENT_ID, to: MAIN_AGENT_ID });
}

test('isolated own,pg_catalog startup ignores public-only reference relations', { timeout: 30000 }, async () => {
  const database = await fixture(false);
  try {
    const foreign = await foreignState(database), originalAgent = (await database.query<Record<string, unknown>>('SELECT * FROM agents')).rows[0];
    assert.equal((await database.query<{ value: string | null }>("SELECT to_regclass('public_only_refs')::text AS value")).rows[0].value, null);
    assert.equal((await database.query<{ value: string | null }>("SELECT to_regclass('public.public_only_refs')::text AS value")).rows[0].value, 'public.public_only_refs');
    // The unmodified migration discovers public_only_refs, then its unqualified
    // UPDATE fails with actual SQLSTATE 42P01. Success requires own discovery.
    await migratePostgresMainAgentId(database);
    assert.deepEqual(await foreignState(database), foreign);
    await verifyMigratedOwnState(database, originalAgent);
  } finally { await database.close(); }
});

test('own,public startup migrates only own refs/defaults and remains idempotent', { timeout: 30000 }, async () => {
  const database = await fixture(true);
  try {
    const foreign = await foreignState(database), originalAgent = (await database.query<Record<string, unknown>>('SELECT * FROM agents')).rows[0];
    assert.equal((await database.query<{ value: string }>("SELECT to_regclass('public_only_refs')::text AS value")).rows[0].value, 'public_only_refs');
    await migratePostgresMainAgentId(database);
    assert.deepEqual(await foreignState(database), foreign, 'Public fallback and third-schema rows/defaults are outside this migration.');
    await verifyMigratedOwnState(database, originalAgent);
    const own = await ownState(database);
    await migratePostgresMainAgentId(database);
    assert.deepEqual(await ownState(database), own); assert.deepEqual(await foreignState(database), foreign);
  } finally { await database.close(); }
});

test('an existing non-main Bradley rejects atomically without touching any schema', { timeout: 30000 }, async () => {
  const database = await fixture(true);
  try {
    await insertAgent(database, MAIN_AGENT_ID, 'custom');
    const own = await ownState(database), foreign = await foreignState(database);
    await assert.rejects(migratePostgresMainAgentId(database), /that ID belongs to a non-main agent/u);
    assert.deepEqual(await ownState(database), own); assert.deepEqual(await foreignState(database), foreign);
  } finally { await database.close(); }
});
