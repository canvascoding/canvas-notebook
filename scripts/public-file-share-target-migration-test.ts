import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { publicFileShares } from '../app/lib/db/schema';
import { createTableSql } from '../app/lib/db/postgres';
import { runPublicFileShareTargetBindingMigration } from '../app/lib/db/public-file-share-target-migration';
import { NATIVE_FILE_OPERATION_SIDE_EFFECT_STATEMENTS, NATIVE_FILE_SIDE_EFFECT_ROW_SPECS } from '../app/lib/db/native-file-operation-side-effects-migration';
import { NATIVE_FILE_SIDE_EFFECT_ROW_SPECS as LEGACY_ROW_SPECS } from './fixtures/file-guest-target-v1/native-file-operation-side-effects-migration';

async function main(): Promise<void> {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/file-guest-target-v1/provenance.json', import.meta.url), 'utf8')) as {
    files: Array<{ fixturePath: string; fixtureSha256: string }>;
  };
  for (const file of provenance.files) {
    const bytes = await readFile(new URL(`../${file.fixturePath}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.fixtureSha256);
  }
  const database = new PGlite();
  const migration = { run: async (sql: string) => { await database.exec(sql); } };
  try {
    // Compile the actual PL/pgSQL guard as well as exercising row projections;
    // malformed private stage SQL must fail this fast fixture before PG18 runs.
    const stageGuard = NATIVE_FILE_OPERATION_SIDE_EFFECT_STATEMENTS.find(sql => sql.startsWith('CREATE OR REPLACE FUNCTION validate_native_file_side_effect_stage'));
    assert(stageGuard); await database.exec(stageGuard);
    await database.exec(createTableSql(publicFileShares));
    const columns = (await database.query<{ column_name: string; is_nullable: string; column_default: unknown }>(
      `SELECT column_name,is_nullable,column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='public_file_shares'
       AND column_name IN('document_id','lineage_id','lifecycle_generation') ORDER BY column_name`,
    )).rows;
    assert.deepEqual(columns.map(row => [row.column_name,row.is_nullable,row.column_default]),
      [['document_id','YES',null],['lifecycle_generation','YES',null],['lineage_id','YES',null]]);
    assert.equal((await database.query(`SELECT conname FROM pg_constraint
      WHERE conrelid='public_file_shares'::regclass AND conname='public_file_share_target_binding_check'`)).rows.length, 1);
    await database.exec(`ALTER TABLE public_file_shares DROP CONSTRAINT public_file_share_target_binding_check,
      DROP COLUMN document_id,DROP COLUMN lineage_id,DROP COLUMN lifecycle_generation`);
    await database.exec(`INSERT INTO public_file_shares(id,token,token_hash,token_preview,workspace_id,workspace_type,
      workspace_path,file_name,file_identity,mime_type,size_bytes,created_by_user_id,created_at,updated_at)
      VALUES('historical','private-token','private-hash','preview','workspace','personal',
        ' exact note.md ','note.md','physical-identity','text/markdown',0,'owner',100,101)`);
    const before = (await database.query<Record<string, unknown>>('SELECT * FROM public_file_shares')).rows;
    const legacy = LEGACY_ROW_SPECS.find(spec => spec.key === 'publicShares')!;
    const current = NATIVE_FILE_SIDE_EFFECT_ROW_SPECS.find(spec => spec.key === 'publicShares')!;
    const projection = async (sql: string, id: string) => (await database.query<{ value: string }>(
      `SELECT (${sql})::text AS value FROM public_file_shares WHERE id=$1`, [id],
    )).rows[0].value;
    const originalProjection = await projection(legacy.json, 'historical');
    for (let repeat = 0; repeat < 2; repeat++) {
      await runPublicFileShareTargetBindingMigration(migration);
      assert.deepEqual((await database.query('SELECT * FROM public_file_shares')).rows,
        before.map(row => ({ ...row, document_id: null, lineage_id: null, lifecycle_generation: null })));
      assert.equal(await projection(current.json, 'historical'), originalProjection,
        'All-null historical V1 JSON and preserved-row proof bytes remain exact.');
    }
    const insert = (id: string, documentId: unknown, lineageId: unknown, generation: unknown, workspaceId: unknown = 'workspace') => database.query(
      `INSERT INTO public_file_shares(id,token,token_hash,token_preview,workspace_id,workspace_type,workspace_path,
        file_name,file_identity,mime_type,size_bytes,created_by_user_id,created_at,updated_at,document_id,lineage_id,lifecycle_generation)
       VALUES($1,$1,$1,'preview',$5,'personal','note.md','note.md','physical-identity','text/markdown',0,'owner',100,101,$2,$3,$4)`,
      [id,documentId,lineageId,generation,workspaceId],
    );
    const invalid: unknown[][] = [
      ['doc',null,null],[null,'lineage',null],[null,null,1],['doc','lineage',null],['doc',null,1],[null,'lineage',1],
      ['doc','lineage',0],['doc','lineage',-1],['doc','lineage','9007199254740991'],
      ['', 'lineage',1],[' doc ','lineage',1],['doc\n','lineage',1],['x'.repeat(257),'lineage',1],
      ['doc','',1],['doc',' lineage ',1],['doc','lineage\n',1],['doc','x'.repeat(257),1],
      ['doc','lineage',1,null],['doc','lineage',1,''],['doc','lineage',1,' workspace '],
    ];
    for (const [index, values] of invalid.entries()) await assert.rejects(
      insert(`invalid-${index}`, values[0], values[1], values[2], values.length > 3 ? values[3] : 'workspace'),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await insert('unbound',null,null,null,null);
    await insert('bound-minimum','native-document','native-lineage',1);
    await insert('bound-maximum','maximum-document','maximum-lineage','9007199254740990');
    const bound = JSON.parse(await projection(current.json, 'bound-minimum'));
    assert.deepEqual(bound.publicBinding, { version: 1, documentId: 'native-document', lineageId: 'native-lineage', lifecycleGeneration: 1 });
    assert.equal(Object.hasOwn(JSON.parse(await projection(current.json, 'unbound')), 'publicBinding'), false);
    const expectedRows = NATIVE_FILE_OPERATION_SIDE_EFFECT_STATEMENTS.find(sql => sql.startsWith('CREATE OR REPLACE FUNCTION native_file_side_effect_expected_rows'));
    assert(expectedRows); await database.exec(expectedRows);
    const rows = { metadata: [], userStates: [], guests: [], publicShares: [bound], locks: [] };
    const after = (await database.query<{ value: typeof rows }>(
      `SELECT native_file_side_effect_expected_rows($1::jsonb,'archive',NULL,200) AS value`, [JSON.stringify(rows)],
    )).rows[0].value;
    assert.deepEqual(after.publicShares[0], { ...bound, status: 'revoked', policyRevision: bound.policyRevision + 1,
      revokedAt: 200, revokedReason: 'target_deleted', updatedAt: 200 });
    const pinned = (await database.query('SELECT * FROM public_file_shares ORDER BY id')).rows;
    await runPublicFileShareTargetBindingMigration(migration);
    assert.deepEqual((await database.query('SELECT * FROM public_file_shares ORDER BY id')).rows, pinned);
    assert.equal(await projection(current.json, 'historical'), originalProjection, 'Repeated migrations never bind a historical path.');
    console.log('PASS Public target migration: actual fresh/old DDL, nullable native pins, complete-tuple constraints, exact historical V1 bytes, versioned binding and unchanged revocation origin.');
  } finally { await database.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
