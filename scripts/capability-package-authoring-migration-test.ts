import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';
import { CAPABILITY_PACKAGE_AUTHORING_MIGRATION_KEY as key, CAPABILITY_PACKAGE_AUTHORING_STATEMENTS } from '../app/lib/db/capability-package-authoring-migration';

async function main() {
  const database = await createSharedConnectionTestDatabase(), raw = await database.openDb();
  const migration = CAPABILITY_PACKAGE_AUTHORING_STATEMENTS[0];
  const sourceColumns = ['base_source_stamp','source_resource_ref','source_metadata_revision','source_grants_revision','source_package_revision','source_storage'];
  const constraints = () => raw.all(`SELECT conname,oid::text AS oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid IN ('capability_package_drafts'::regclass,'capability_package_versions'::regclass)
      AND conname IN ('capability_package_drafts_operation_check','capability_package_drafts_source_check','capability_package_versions_source_check') ORDER BY conname`);
  const sourceNullability = () => raw.all(`SELECT attname,attnotnull FROM pg_attribute WHERE attrelid='capability_package_drafts'::regclass
    AND attname=ANY($1::text[]) ORDER BY attname`, [sourceColumns]);
  const receipt = () => raw.get('SELECT completed_at,metadata_json FROM canvas_data_migrations WHERE migration_key=$1', [key]);
  try {
    // The fresh schema has the checks too; a completed startup must leave their OIDs untouched.
    const fresh = await constraints(), firstReceipt = await receipt();
    assert.equal(fresh.length,3); assert(firstReceipt);
    await raw.run(migration); await raw.run(migration);
    assert.deepEqual(await constraints(),fresh); assert.deepEqual(await receipt(),firstReceipt);

    // Reconstruct the pre-P1 shape only inside this owned, empty fixture database.
    await raw.run('DELETE FROM canvas_data_migrations WHERE migration_key=$1', [key]);
    await raw.run('ALTER TABLE capability_package_drafts DROP CONSTRAINT capability_package_drafts_source_check');
    await raw.run('ALTER TABLE capability_package_versions DROP CONSTRAINT capability_package_versions_source_check');
    await raw.run('ALTER TABLE capability_package_drafts DROP CONSTRAINT capability_package_drafts_operation_check');
    await raw.run("ALTER TABLE capability_package_drafts ADD CONSTRAINT capability_package_drafts_operation_check CHECK (operation IN ('edit','fork'))");
    for (const column of sourceColumns) await raw.run(`ALTER TABLE capability_package_drafts ALTER COLUMN ${column} SET NOT NULL`);
    for (const column of ['source_resource_ref','source_checksum','source_stamp']) await raw.run(`ALTER TABLE capability_package_versions ALTER COLUMN ${column} SET NOT NULL`);
    const before = await constraints(), beforeNullability = await sourceNullability();
    assert(beforeNullability.every(row => (row as {attnotnull:boolean}).attnotnull));
    const failedMigration = migration.replace('INSERT INTO canvas_data_migrations', "RAISE EXCEPTION 'forced authoring migration rollback'; INSERT INTO canvas_data_migrations");
    await assert.rejects(async () => raw.run(failedMigration), /forced authoring migration rollback/u);
    assert.deepEqual(await constraints(),before,'Failed migration restores the original constraint definitions and OIDs.');
    assert.deepEqual(await sourceNullability(),beforeNullability,'Failed migration restores NOT NULL columns.');
    assert.equal(await receipt(),undefined,'No completion receipt survives a rolled-back migration.');

    if (database.native) {
      const second = await database.openDb();
      try { await Promise.all([raw.run(migration),second.run(migration)]); }
      finally { await second.close(); }
    } else await raw.run(migration);
    const migrated = await constraints(), completed = await receipt();
    assert.equal(migrated.length,3); assert(completed);
    assert((await sourceNullability()).every(row => !(row as {attnotnull:boolean}).attnotnull));
    await raw.run(migration);
    assert.deepEqual(await constraints(),migrated,'A retry never rebuilds already committed constraints.');
    assert.deepEqual(await receipt(),completed,'The original migration receipt remains immutable.');

    await raw.run(`INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES ('authoring-migration-owner','Migration owner','migration-owner@example.test',1,'user',0,1000,1000)`);
    const insertDraft = (operation:string,source:boolean) => raw.run(`INSERT INTO capability_package_drafts
      (draft_ref,resource_ref,actor_user_id,kind,name,operation,draft_revision,base_package_revision,base_source_stamp,source_resource_ref,
       source_metadata_revision,source_grants_revision,source_package_revision,source_storage,target_storage,target_ownership,created_at,updated_at)
      VALUES ($1,$2,'authoring-migration-owner','skill','migration-fixture',$3,1,0,$4,$5,$6,$6,$7,$4,'{}','{}',1000,1000)`,
    [`canvas-package-draft:${randomUUID()}`,`canvas-resource:${randomUUID()}`,operation,source?'{}':null,source?'legacy-source':null,source?1:null,source?0:null]);
    await insertDraft('create',false); await insertDraft('edit',true); await insertDraft('fork',true);
    await assert.rejects(async () => insertDraft('create',true), /capability_package_drafts_source_check/u);
    await assert.rejects(async () => insertDraft('edit',false), /capability_package_drafts_source_check/u);
    console.log(`PASS ${database.native?'native PostgreSQL':'PGlite'} authoring migration: atomic rollback, legacy shape, source checks, one receipt, stable constraint OIDs and ${database.native?'overlapping ':''}retries.`);
  } finally { await raw.close(); await database.close(); }
}

main().catch(error => { console.error(error); process.exitCode=1; });
