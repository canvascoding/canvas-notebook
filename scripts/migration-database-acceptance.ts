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
  try {
    await client.query('BEGIN');
    const manifest = { users: snapshot.header.users, source: { organizationId: snapshot.header.organizationId } } as Parameters<typeof stagePortableDatabase>[2];
    const stage = await stagePortableDatabase(client, file, manifest);
    await replacePortableDatabase(client, stage);
    assert.equal(await fingerprint(), before);
    assert.equal((await client.query('SELECT count(*) FROM "session"')).rows[0].count, '0');
    assert.equal((await client.query("SELECT count(*) FROM automation_jobs WHERE status='active'")).rows[0].count, '0');
    const bad = await client.query('SELECT count(*) FROM account WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL OR id_token IS NOT NULL');
    assert.equal(bad.rows[0].count, '0');
    await client.query('ROLLBACK');
    assert.equal(await fingerprint(), before);
    console.log(JSON.stringify({ result: 'PASS', snapshotBytes: snapshot.bytes, tables: stage.tables.size, rows: stage.rows,
      targetLicensePreserved: true, transactionRollbackVerified: true }));
  } finally { await client.query('ROLLBACK').catch(() => undefined); await client.end(); }
}
main().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : 'Database acceptance failed.'); process.exit(1); });
