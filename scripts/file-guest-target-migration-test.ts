import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { fileGuestInvitations } from '../app/lib/db/schema';
import { createTableSql } from '../app/lib/db/postgres';
import { runFileGuestTargetBindingMigration } from '../app/lib/db/file-guest-target-migration';
import { NATIVE_FILE_SIDE_EFFECT_ROW_SPECS } from '../app/lib/db/native-file-operation-side-effects-migration';
import { NATIVE_FILE_SIDE_EFFECT_ROW_SPECS as LEGACY_ROW_SPECS } from './fixtures/file-guest-target-v1/native-file-operation-side-effects-migration';

async function main(): Promise<void> {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/file-guest-target-v1/provenance.json', import.meta.url), 'utf8')) as {
    sourceCommit: string; files: Array<{ originalPath: string; fixturePath: string; originalSha256: string; fixtureSha256: string }>;
  };
  assert.equal(provenance.sourceCommit, '6cac42e1873d873f1ef311cd7f362a02e51b0c56');
  for (const file of provenance.files) {
    const fixture = await readFile(new URL(`../${file.fixturePath}`, import.meta.url), 'utf8');
    assert.equal(createHash('sha256').update(fixture).digest('hex'), file.fixtureSha256);
    const original = fixture
      .replaceAll("'./native-file-operation-side-effects-migration'", "'../db/native-file-operation-side-effects-migration'")
      .replaceAll("'../../../app/lib/markdown/native-file-operation-handoff'", "'./native-file-operation-handoff'")
      .replaceAll("'../../../app/lib/db'", "'../db'")
      .replaceAll("'../../../app/lib/workspaces/types'", "'../workspaces/types'")
      .replaceAll("'../../../app/lib/collaboration/", "'../collaboration/");
    assert.equal(createHash('sha256').update(original).digest('hex'), file.originalSha256,
      `Frozen ${file.originalPath} may differ only in relative imports.`);
  }

  const database = new PGlite();
  const migration = { run: async (sql: string) => { await database.exec(sql); } };
  try {
    // The actual schema renderer covers a new installation first.
    await database.exec(createTableSql(fileGuestInvitations));
    const columns = (await database.query<{ column_name: string; is_nullable: string; column_default: unknown }>(
      `SELECT column_name,is_nullable,column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='file_guest_invitations'
         AND column_name IN('lineage_id','lifecycle_generation') ORDER BY column_name`,
    )).rows;
    assert.deepEqual(columns.map(row => [row.column_name,row.is_nullable,row.column_default]),
      [['lifecycle_generation','YES',null],['lineage_id','YES',null]]);
    assert.equal((await database.query(`SELECT conname FROM pg_constraint
      WHERE conrelid='file_guest_invitations'::regclass AND conname='file_guest_target_binding_check'`)).rows.length, 1);

    // No application rows exist yet. Recreate the real old table shape so the
    // legacy projection and digest are computed before either new column exists.
    await database.exec(`ALTER TABLE file_guest_invitations DROP CONSTRAINT file_guest_target_binding_check,
      DROP COLUMN lifecycle_generation,DROP COLUMN lineage_id`);
    await database.exec(`INSERT INTO file_guest_invitations(id,workspace_id,path,document_id,email,permission,
      created_by_user_id,assets_json,challenge_id,challenge_hash,created_at,updated_at)
      VALUES('historical','workspace',' exact note.md ','document','private@example.invalid','read',
        'inviter','[]','challenge','private-otp-hash',100,101)`);
    const before = (await database.query<Record<string, unknown>>('SELECT * FROM file_guest_invitations')).rows;
    const legacy = LEGACY_ROW_SPECS.find(spec => spec.key === 'guests')!;
    const current = NATIVE_FILE_SIDE_EFFECT_ROW_SPECS.find(spec => spec.key === 'guests')!;
    const legacyProjection = (await database.query<{ projection: string }>(
      `SELECT (${legacy.json})::text AS projection FROM file_guest_invitations WHERE id='historical'`,
    )).rows[0].projection;
    for (let repeat = 0; repeat < 2; repeat++) {
      await runFileGuestTargetBindingMigration(migration);
      assert.deepEqual((await database.query('SELECT * FROM file_guest_invitations')).rows,
        before.map(row => ({ ...row, lifecycle_generation: null, lineage_id: null })));
      assert.equal((await database.query<{ projection: string }>(
        `SELECT (${current.json})::text AS projection FROM file_guest_invitations WHERE id='historical'`,
      )).rows[0].projection, legacyProjection, 'Unbound V1 JSON and preserved-row proof bytes stay exact.');
    }

    const insert = (id: string, generation: unknown, lineage: unknown) => database.query(
      `INSERT INTO file_guest_invitations(id,workspace_id,path,document_id,email,permission,created_by_user_id,
        created_at,updated_at,lifecycle_generation,lineage_id) VALUES($1,'workspace','note.md','document',
        'private@example.invalid','read','inviter',100,101,$2,$3)`, [id,generation,lineage],
    );
    for (const [index,pair] of [[null,'lineage'],[1,null],[0,'lineage'],[-1,'lineage'],
      ['9007199254740991','lineage'],[1,''],[1,' line '],[1,'line\n'],[1,'x'.repeat(257)]].entries()) {
      await assert.rejects(insert(`invalid-${index}`, pair[0], pair[1]),
        (error: unknown) => (error as { code?: string }).code === '23514');
    }
    await insert('unbound',null,null);
    await insert('bound-minimum',1,'lineage');
    await insert('bound-maximum','9007199254740990','lineage-max');
    await database.exec("UPDATE file_guest_invitations SET lifecycle_generation=1,lineage_id='lineage-original' WHERE id='historical'");
    const bound = JSON.parse((await database.query<{ projection: string }>(
      `SELECT (${current.json})::text AS projection FROM file_guest_invitations WHERE id='historical'`,
    )).rows[0].projection);
    assert.deepEqual(bound.guestBinding, { version: 1, lineageId: 'lineage-original', lifecycleGeneration: 1 });
    const { guestBinding: _binding, ...legacyFields } = bound;
    assert.deepEqual(legacyFields, JSON.parse(legacyProjection));
    const pinnedBefore = (await database.query('SELECT * FROM file_guest_invitations ORDER BY id')).rows;
    await runFileGuestTargetBindingMigration(migration);
    assert.deepEqual((await database.query('SELECT * FROM file_guest_invitations ORDER BY id')).rows, pinnedBefore);
    console.log('PASS Guest target migration: real old/fresh DDL, null historical targets, pair constraints, exact legacy JSON/proofs, explicit bound target and immutable fixture provenance.');
  } finally { await database.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
