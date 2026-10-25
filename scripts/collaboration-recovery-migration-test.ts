import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { COLLABORATION_RECOVERY_STATEMENTS } from '../app/lib/db/collaboration-recovery-migration';

test('recovery kind upgrade is atomic, repeatable and preserves every original backup byte', async () => {
  const database = new PGlite();
  try {
    const original = COLLABORATION_RECOVERY_STATEMENTS[0].replace(", 'repair_initial_append'", '');
    assert(!original.includes('repair_initial_append')); await database.exec(original);
    const insert = (id: string, kind: string) => database.query(`INSERT INTO collaboration_recovery_state_mutations
      (operation_id,backup_id,kind,document_id,before_metadata,before_update,before_vector,after_metadata,
        after_update_hash,after_vector_hash,created_at)
      VALUES ($1,$1,$2,'isolated-schema-fixture','{"original":"retained"}'::jsonb,$3,$4,'{}'::jsonb,$5,$5,1)`,
    [id, kind, new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), '0'.repeat(64)]);
    await insert('original-code-repair', 'repair_code_marks'); await insert('original-archive', 'archive_orphan');
    const before = (await database.query('SELECT * FROM collaboration_recovery_state_mutations ORDER BY operation_id')).rows;
    await assert.rejects(insert('not-yet-supported', 'repair_initial_append'));
    for (const statement of COLLABORATION_RECOVERY_STATEMENTS) await database.exec(statement);
    assert.deepEqual((await database.query('SELECT * FROM collaboration_recovery_state_mutations ORDER BY operation_id')).rows, before);
    await insert('new-append-repair', 'repair_initial_append');
    const upgraded = (await database.query('SELECT * FROM collaboration_recovery_state_mutations ORDER BY operation_id')).rows;
    for (const statement of COLLABORATION_RECOVERY_STATEMENTS) await database.exec(statement);
    assert.deepEqual((await database.query('SELECT * FROM collaboration_recovery_state_mutations ORDER BY operation_id')).rows, upgraded);
    await assert.rejects(insert('unknown-kind', 'replace_everything'));
  } finally { await database.close(); }
});
