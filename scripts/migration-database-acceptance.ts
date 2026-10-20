import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { createHash } from 'node:crypto';

async function main() {
  if (process.env.EXPORT_MIGRATION_ACCEPTANCE !== '1') throw new Error('Explicit isolated acceptance mode is required.');
  const root = path.join(os.homedir(), '.local/state/canvas-local-team-seat/export-migration-99b4');
  const source = parse(await fs.readFile(path.join(root, 'source.env'))); const target = parse(await fs.readFile(path.join(root, 'target.env')));
  for (const [kind, env] of [['source', source], ['target', target]] as const) {
    if (new URL(env.DATABASE_URL).pathname !== '/canvas_export_99b4_' + kind || env.DATA !== path.join(root, kind + '-data')) throw new Error('Refusing a non-fixture database.');
  }
  Object.assign(process.env, source);
  const { exportPortableDatabase } = await import('../app/lib/migration/database-export');
  const { stagePortableDatabase, replacePortableDatabase } = await import('../app/lib/migration/database-restore');
  const file = path.join(root, 'probe-postgres.jsonl.gz'); await fs.rm(file, { force: true });
  const snapshot = await exportPortableDatabase(file);
  const client = new Client({ connectionString: target.DATABASE_URL }); await client.connect();
  const fingerprint = async () => {
    const rows = (await client.query('SELECT row_to_json(t)::text value FROM license_certs t ORDER BY id')).rows;
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  };
  const before = await fingerprint();
  const triggerModes = async () => (await client.query(`SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,t.tgname`)).rows;
  const triggersBefore = await triggerModes();
  try {
    await client.query('BEGIN');
    const manifest = { users: snapshot.header.users, source: { organizationId: snapshot.header.organizationId } } as Parameters<typeof stagePortableDatabase>[2];
    const stage = await stagePortableDatabase(client, file, manifest);
    const core = ['automation_jobs', 'automation_runs', 'file_change_proposals', 'file_proposal_action_receipts',
      'file_change_groups', 'file_agent_turn_checkpoints', 'capability_package_operations', 'pi_messages', 'collaboration_yjs_states'];
    for (const name of core) assert.ok(stage.tables.has(name), 'Stored application data must be copied: ' + name);
    const { sqlName } = await import('../app/lib/migration/database-schema');
    const expected = new Map<string, string>();
    for (const { table, temporary } of stage.tables.values()) expected.set(table.name,
      (await client.query(`SELECT count(*)::text count FROM ${sqlName(temporary)}`)).rows[0].count);
    await replacePortableDatabase(client, stage);
    assert.deepEqual(await triggerModes(), triggersBefore, 'All database trigger modes must be restored.');
    for (const { table } of stage.tables.values()) {
      const actual = (await client.query(`SELECT count(*)::text count FROM public.${sqlName(table.name)}`)).rows[0].count;
      if (['user', 'account'].includes(table.name)) assert.ok(Number(actual) >= Number(expected.get(table.name)));
      else assert.equal(actual, expected.get(table.name), 'Complete row transfer: ' + table.name);
    }
    assert.ok(Number(expected.get('automation_jobs')) > 0, 'The real fixture must contain automation data.');
    assert.equal(await fingerprint(), before);
    assert.equal((await client.query('SELECT count(*) FROM "session"')).rows[0].count, '0');
    assert.equal((await client.query("SELECT count(*) FROM automation_jobs WHERE status='active'")).rows[0].count, '0');
    const bad = await client.query('SELECT count(*) FROM account WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL OR id_token IS NOT NULL');
    assert.equal(bad.rows[0].count, '0');
    await client.query('ROLLBACK');
    assert.deepEqual(await triggerModes(), triggersBefore, 'Rollback must retain all database trigger modes.');
    assert.equal(await fingerprint(), before);
    console.log(JSON.stringify({ result: 'PASS', snapshotBytes: snapshot.bytes, tables: stage.tables.size, rows: stage.rows,
      targetLicensePreserved: true, transactionRollbackVerified: true }));
  } finally { await client.query('ROLLBACK').catch(() => undefined); await client.end(); }
}
main().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : 'Database acceptance failed.'); process.exit(1); });
