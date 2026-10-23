/** Owned QA only. Installs one exact Copy B2 INSERT fault; never edits application rows. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { assertDatabaseOwnership, privateBytes, requireOwnedYjsQaTarget, writePrivateJson,
  type DatabaseIdentity, type OwnedYjsReceipt } from './lib/owned-yjs-authority-qa';
import { assertOwnedCopyB2FaultBinding, captureOwnedCopyB2FaultInput, ownedCopyB2FaultDefinition,
  type OwnedCopyB2FaultInput } from './lib/owned-yjs-native-copy-b2-fault';

type Storage = { schemaOid: string; tableOid: string; roleOid: string };
type Catalog = { sequence: Record<string, unknown>[]; function: Record<string, unknown>[]; trigger: Record<string, unknown>[] };
type FaultReceipt = { version: 1; input: OwnedCopyB2FaultInput; databaseOid: string; ownerMarker: string;
  storage: Storage; marker: string; bodySha256: string; state: 'intent' | 'prepared' | 'armed' | 'dropping' | 'closed'; catalog: Catalog | null };
const empty = (catalog: Catalog) => Object.values(catalog).every(rows => rows.length === 0);

async function durable(filename: string, receipt: FaultReceipt, exclusive = false): Promise<void> {
  await writePrivateJson(filename, receipt, exclusive);
  const file = await fs.open(filename, 'r'); try { await file.sync(); } finally { await file.close(); }
  const directory = await fs.open(path.dirname(filename), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
async function identity(database: Client, owned: OwnedYjsReceipt): Promise<Storage> {
  const result = await database.query(`SELECT current_database() AS name,d.oid::text,pg_catalog.pg_get_userbyid(d.datdba) AS owner,
    current_user AS role,pg_catalog.shobj_description(d.oid,'pg_database') AS marker
    FROM pg_catalog.pg_database d WHERE d.datname=current_database()`);
  assert.equal(result.rowCount, 1); assertDatabaseOwnership(owned, result.rows[0] as DatabaseIdentity);
  const row = (await database.query(`SELECT n.oid::text AS "schemaOid",c.oid::text AS "tableOid",r.oid::text AS "roleOid"
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid
    JOIN pg_catalog.pg_roles r ON r.rolname=current_user
    WHERE n.nspname='public' AND c.relname='workspace_file_metadata' AND c.relkind='r'
    AND c.relowner=r.oid AND current_schema()='public'`)).rows;
  assert.equal(row.length, 1); return row[0] as Storage;
}
async function catalogue(database: Client, input: OwnedCopyB2FaultInput): Promise<Catalog> {
  const { names } = ownedCopyB2FaultDefinition(input);
  const sequence = (await database.query(`SELECT c.oid::text,c.relowner::text AS owner,c.relkind,
    pg_catalog.obj_description(c.oid,'pg_class') AS marker,s.seqtypid::text,s.seqstart::text,s.seqincrement::text,
    s.seqmin::text,s.seqmax::text,s.seqcache::text,s.seqcycle
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid WHERE n.nspname='public' AND c.relname=$1`, [names.sequence])).rows;
  const fn = (await database.query(`SELECT p.oid::text,p.proowner::text AS owner,p.prokind,p.prorettype::text,p.pronargs,
    p.prosecdef,p.prosrc,p.proconfig,l.lanname,pg_catalog.obj_description(p.oid,'pg_proc') AS marker
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname=$1 ORDER BY p.oid`, [names.function])).rows;
  const trigger = (await database.query(`SELECT t.oid::text,t.tgrelid::text,t.tgfoid::text,t.tgtype,t.tgenabled,t.tgisinternal,
    t.tgnargs,t.tgqual::text,t.tgconstraint::text,pg_catalog.obj_description(t.oid,'pg_trigger') AS marker
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND t.tgname=$1 ORDER BY t.oid`, [names.trigger])).rows;
  return { sequence, function: fn, trigger };
}
function assertCatalogue(catalog: Catalog, receipt: FaultReceipt): void {
  const definition = ownedCopyB2FaultDefinition(receipt.input);
  for (const rows of Object.values(catalog)) assert.equal(rows.length, 1);
  const s = catalog.sequence[0], f = catalog.function[0], t = catalog.trigger[0];
  assert.deepEqual(s, { oid: s.oid, owner: receipt.storage.roleOid, relkind: 'S', marker: definition.marker,
    seqtypid: '20', seqstart: '1', seqincrement: '1', seqmin: '1', seqmax: '9223372036854775807', seqcache: '1', seqcycle: false });
  assert.deepEqual(f, { oid: f.oid, owner: receipt.storage.roleOid, prokind: 'f', prorettype: '2279', pronargs: 0,
    prosecdef: false, prosrc: definition.body, proconfig: ['search_path=pg_catalog'], lanname: 'plpgsql', marker: definition.marker });
  assert.deepEqual(t, { oid: t.oid, tgrelid: receipt.storage.tableOid, tgfoid: f.oid, tgtype: 7, tgenabled: 'O',
    tgisinternal: false, tgnargs: 0, tgqual: null, tgconstraint: '0', marker: definition.marker });
  for (const row of [s, f, t]) assert(typeof row.oid === 'string' && /^[1-9][0-9]*$/u.test(row.oid));
  if (receipt.catalog) assert.deepEqual(catalog, receipt.catalog, 'Owned fault catalogue identity changed.');
}
async function verifyArmScope(database: Client, input: OwnedCopyB2FaultInput): Promise<void> {
  const workspaces = (await database.query(`SELECT id FROM public.canvas_workspaces WHERE id=ANY($1::text[])
    AND owner_user_id=$2 AND type='personal' AND status='active' ORDER BY id`,
  [[input.sourceWorkspaceId, input.destinationWorkspaceId], input.actorUserId])).rows;
  assert.equal(workspaces.length, 2);
  const source = (await database.query(`SELECT d.id FROM public.collaboration_documents d
    JOIN public.collaboration_yjs_states s ON s.document_id=d.id AND s.workspace_id=d.workspace_id AND s.path=d.path
    WHERE d.workspace_id=$1 AND d.path=$2 AND d.id=$3 AND d.status='active' AND s.status='active'
    AND s.lifecycle_generation=$4 AND EXISTS(SELECT 1 FROM public.workspace_file_metadata m
      WHERE m.workspace_id=d.workspace_id AND m.path=d.path AND m.title IS NOT NULL)`,
  [input.sourceWorkspaceId, input.sourcePath, input.sourceDocumentId, input.sourceGeneration])).rows;
  assert.equal(source.length, 1);
  const counts = (await database.query(`SELECT
    (SELECT count(*)::int FROM public.collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status='active') AS docs,
    (SELECT count(*)::int FROM public.workspace_file_metadata WHERE workspace_id=$1 AND path=$2) AS metadata,
    (SELECT count(*)::int FROM public.workspace_file_user_states WHERE workspace_id=$1 AND path=$2) AS annotations,
    (SELECT count(*)::int FROM public.workspace_file_operations WHERE operation_id=$3) AS journal,
    (SELECT count(*)::int FROM public.collaboration_native_copy_receipts WHERE operation_id=$3) AS ledger`,
  [input.destinationWorkspaceId, input.destinationPath, input.operationId])).rows[0];
  assert.deepEqual(counts, { docs: 0, metadata: 0, annotations: 0, journal: 0, ledger: 0 });
}
async function main(): Promise<void> {
  assert.equal(process.argv.length, 3); assert(process.argv[2].length <= 8192);
  const bytes = Buffer.from(process.argv[2], 'base64url'); assert.equal(bytes.toString('base64url'), process.argv[2]);
  const input = captureOwnedCopyB2FaultInput(JSON.parse(bytes.toString('utf8')));
  const environment = Object.freeze({ ...process.env });
  const owned = await requireOwnedYjsQaTarget(environment); assertOwnedCopyB2FaultBinding(input, owned);
  const published = parse(await privateBytes(path.join(owned.fixtureRoot, 'runtime.env')));
  const filename = path.join(owned.fixtureRoot, `copy-b2-fault-${input.faultId}.json`), definition = ownedCopyB2FaultDefinition(input);
  const database = new Client({ connectionString: published.DATABASE_URL, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 6000, lock_timeout: 4000,
    application_name: `owned_copy_fault_${input.faultId}` });
  let transaction = false;
  try {
    await database.connect(); await database.query('SET search_path=public,pg_catalog');
    const storage = await identity(database, owned);
    const expected: FaultReceipt = { version: 1, input: { ...input, action: 'arm' }, databaseOid: owned.databaseOid!,
      ownerMarker: owned.ownerMarker, storage, marker: definition.marker, bodySha256: definition.bodySha256, state: 'intent', catalog: null };
    let receipt: FaultReceipt;
    try { receipt = JSON.parse((await privateBytes(filename)).toString('utf8')) as FaultReceipt; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (input.action === 'cleanup') {
        // An arm failure before its exclusive intent write cannot own DDL objects.
        assert(empty(await catalogue(database, input))); process.stdout.write(JSON.stringify({ removed: true, fired: false, matchingAttempts: '0' })); return;
      }
      receipt = expected; await durable(filename, receipt, true);
    }
    assert.deepEqual({ ...receipt, state: 'intent', catalog: null }, expected);
    assert(['intent', 'prepared', 'armed', 'dropping', 'closed'].includes(receipt.state));
    await database.query('BEGIN'); transaction = true;
    assert.deepEqual(await identity(database, owned), storage);
    await database.query('LOCK TABLE public.workspace_file_metadata IN SHARE ROW EXCLUSIVE MODE');
    let actual = await catalogue(database, input);
    if (input.action === 'arm') {
      assert(receipt.state !== 'closed' && receipt.state !== 'dropping');
      if (empty(actual)) {
        // Never adopt replacement OIDs after an acknowledged/prepared installation.
        assert.equal(receipt.state, 'intent'); assert.equal(receipt.catalog, null);
        await verifyArmScope(database, input);
        for (const sql of definition.create) await database.query(sql);
        actual = await catalogue(database, input); assertCatalogue(actual, receipt);
        receipt = { ...receipt, state: 'prepared', catalog: actual };
        // OIDs exist inside this TX and are saved BEFORE COMMIT, including a lost ACK.
        await durable(filename, receipt);
      } else { assert(receipt.catalog, 'No pre-COMMIT OID proof exists.'); assertCatalogue(actual, receipt); }
      await database.query('COMMIT'); transaction = false;
      await durable(filename, { ...receipt, state: 'armed' });
      process.stdout.write(JSON.stringify({ armed: true, faultId: input.faultId }));
    } else {
      let fired = false, matchingAttempts = '0';
      if (!empty(actual)) {
        assert(receipt.state !== 'closed' && receipt.catalog); assertCatalogue(actual, receipt);
        const sequence = (await database.query(`SELECT last_value::text,is_called FROM public."${definition.names.sequence}"`)).rows[0];
        assert(typeof sequence.last_value === 'string' && typeof sequence.is_called === 'boolean');
        fired = sequence.is_called; matchingAttempts = fired ? sequence.last_value : '0';
        await durable(filename, { ...receipt, state: 'dropping' });
        await database.query(`DROP TRIGGER "${definition.names.trigger}" ON public.workspace_file_metadata RESTRICT`);
        await database.query(`DROP FUNCTION public."${definition.names.function}"() RESTRICT`);
        await database.query(`DROP SEQUENCE public."${definition.names.sequence}" RESTRICT`);
        assert(empty(await catalogue(database, input)));
      }
      await database.query('COMMIT'); transaction = false;
      await durable(filename, { ...receipt, state: 'closed' });
      process.stdout.write(JSON.stringify({ removed: true, fired, matchingAttempts }));
    }
  } finally {
    try { if (transaction) await database.query('ROLLBACK'); } finally { await database.end(); }
  }
}
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
void main().then(() => { completed = true; }).catch(() => {
  console.error('Owned Copy B2 fault fixture did not complete; its private intent and catalogue pins are retained.'); process.exitCode = 1;
});
