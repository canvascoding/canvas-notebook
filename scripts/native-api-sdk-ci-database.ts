import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { appendFile, lstat, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { assertNativeTestDatabaseTarget, readNativeTestDatabaseConfig } from './helpers/native-test-database-config';

type Receipt = Readonly<{ version: 1; runId: string; databaseName: string; databaseOid: string; owner: string;
  directory: string; device: number; inode: number }>;
function adminUrl(value: string): URL {
  assert(typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\u0000-\u0020\u007f]/u.test(value), 'Invalid native CI administration URL.');
  let url: URL; try { url = new URL(value); } catch { throw new Error('Invalid native CI administration URL.'); }
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1'
    && /^[0-9]{1,5}$/u.test(url.port) && Number(url.port) > 0 && Number(url.port) <= 65535
    && url.pathname === '/postgres' && !url.search && !url.hash, 'Native CI administration must use the explicit loopback maintenance database.');
  return url;
}
async function connectAdministration(value: string) {
  assert.equal(process.env.NODE_ENV, 'test');
  const url = adminUrl(value), client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c lock_timeout=5000', application_name: 'canvas-native-ci-administration' });
  client.on('error', () => undefined);
  try {
    await client.connect(); const row = (await client.query(`SELECT current_database() AS database,current_user AS role,
      current_setting('server_version_num') AS version`)).rows[0];
    assert.equal(row.database, 'postgres'); assert.equal(Math.floor(Number(row.version) / 10000), 18);
    assert.equal(typeof row.role, 'string'); return { client, url, owner: String(row.role) };
  } catch (error) { await client.end(); throw error; }
}
export async function createNativeCiDatabase(maintenanceUrl: string, outputParent: string) {
  const { client, url, owner } = await connectAdministration(maintenanceUrl);
  const runId = crypto.randomUUID().replaceAll('-', ''), databaseName = `canvas_native_ci_${runId}`;
  let created = false, databaseOid: string | undefined, marked = false, directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(await realpath(outputParent), 'canvas-native-ci-'));
    const directoryIdentity = await lstat(directory), receiptFile = path.join(directory, 'database.json');
    assert(directoryIdentity.isDirectory() && !directoryIdentity.isSymbolicLink() && directoryIdentity.uid === process.getuid?.()
      && (directoryIdentity.mode & 0o077) === 0);
    await client.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`); created = true;
    const row = (await client.query('SELECT oid::text AS oid,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [databaseName])).rows[0];
    assert(row && row.owner === owner && /^[1-9][0-9]*$/u.test(row.oid)); databaseOid = String(row.oid);
    await client.query(`COMMENT ON DATABASE "${databaseName}" IS 'canvas-native-tests:${runId}'`); marked = true;
    const receipt: Receipt = { version: 1, runId, databaseName, databaseOid, owner, directory,
      device: directoryIdentity.dev, inode: directoryIdentity.ino };
    await writeFile(receiptFile, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    url.pathname = `/${databaseName}`;
    return { receipt, receiptFile, connectionString: url.toString() };
  } catch (error) {
    if (created) {
      const row = (await client.query(`SELECT oid::text AS oid,pg_get_userbyid(datdba) AS owner,
        shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [databaseName])).rows[0];
      assert(row && row.owner === owner && (databaseOid === undefined || row.oid === databaseOid));
      assert.equal(row.marker, marked ? `canvas-native-tests:${runId}` : null);
      await client.query(`DROP DATABASE "${databaseName}"`);
    }
    if (directory) await rm(directory, { recursive: true }); throw error;
  } finally { await client.end(); }
}
export async function cleanupNativeCiDatabase(maintenanceUrl: string, receiptFile: string) {
  assert(path.isAbsolute(receiptFile));
  const file = await lstat(receiptFile); assert(file.isFile() && !file.isSymbolicLink()
    && file.uid === process.getuid?.() && (file.mode & 0o077) === 0 && file.size <= 4096);
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as Receipt;
  assert.equal(receipt.version, 1); assert.match(receipt.runId, /^[a-f0-9]{32}$/u);
  assert.equal(receipt.databaseName, `canvas_native_ci_${receipt.runId}`); assert.match(receipt.databaseOid, /^[1-9][0-9]*$/u);
  assert.equal(receipt.directory, await realpath(path.dirname(receiptFile)));
  assert.match(path.basename(receipt.directory), /^canvas-native-ci-[A-Za-z0-9]+$/u);
  const directory = await lstat(receipt.directory);
  assert(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid?.()
    && directory.dev === receipt.device && directory.ino === receipt.inode && (directory.mode & 0o077) === 0);
  assert.deepEqual(await readdir(receipt.directory), ['database.json']);
  const { client, url, owner } = await connectAdministration(maintenanceUrl);
  try {
    assert.equal(owner, receipt.owner);
    const row = (await client.query(`SELECT oid::text AS oid,pg_get_userbyid(datdba) AS owner,
      shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [receipt.databaseName])).rows[0];
    assert(row && row.oid === receipt.databaseOid && row.owner === owner && row.marker === `canvas-native-tests:${receipt.runId}`,
      'The owned native CI database identity changed; cleanup is refused.');
    url.pathname = `/${receipt.databaseName}`;
    const config = await readNativeTestDatabaseConfig({ env: { NODE_ENV: 'test', CI: 'true',
      CANVAS_NATIVE_TEST_DATABASE_URL: url.toString(), CANVAS_NATIVE_TEST_RUN_ID: receipt.runId } });
    const inspection = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=15000', application_name: 'canvas-native-ci-inspection' });
    let schemas = 0, relations = 0, backends = 0;
    try {
      await inspection.connect(); await assertNativeTestDatabaseTarget(inspection, config);
      schemas = Number((await inspection.query(`SELECT count(*)::int AS n FROM pg_namespace
        WHERE nspname<>'public' AND nspname<>'information_schema' AND left(nspname,3)<>'pg_'`)).rows[0].n);
      relations = Number((await inspection.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')`)).rows[0].n);
      backends = Number((await inspection.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datid=$1::oid AND pid<>pg_backend_pid()`, [receipt.databaseOid])).rows[0].n);
    } finally { await inspection.end(); }
    const prefix = `canvas-native-child:${receipt.runId}:`;
    const children = (await client.query(`SELECT datname,pg_get_userbyid(datdba) AS owner,
      shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE shobj_description(oid,'pg_database') LIKE $1`, [`${prefix}%`])).rows;
    for (const child of children) {
      assert.match(child.datname, /^canvas_connection_test_[a-f0-9]{32}$/u);
      assert.equal(child.owner, owner); assert.equal(child.marker, prefix + child.datname);
      await client.query(`DROP DATABASE "${child.datname}" WITH (FORCE)`);
    }
    const current = (await client.query(`SELECT oid::text AS oid,pg_get_userbyid(datdba) AS owner,
      shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [receipt.databaseName])).rows[0];
    assert(current && current.oid === receipt.databaseOid && current.owner === owner && current.marker === `canvas-native-tests:${receipt.runId}`);
    await client.query(`DROP DATABASE "${receipt.databaseName}" WITH (FORCE)`);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM pg_database WHERE oid=$1::oid', [receipt.databaseOid])).rows[0].n, 0);
    const finalDirectory = await lstat(receipt.directory);
    assert(finalDirectory.isDirectory() && !finalDirectory.isSymbolicLink() && finalDirectory.uid === process.getuid?.()
      && finalDirectory.dev === receipt.device && finalDirectory.ino === receipt.inode);
    assert.deepEqual(await readdir(receipt.directory), ['database.json']);
    await rm(receipt.directory, { recursive: true });
    return { removed: true, noLeaks: schemas === 0 && relations === 0 && backends === 0 && children.length === 0,
      remainingSchemasBeforeCleanup: schemas, remainingPublicRelationsBeforeCleanup: relations,
      remainingBackendsBeforeCleanup: backends, remainingChildDatabasesBeforeCleanup: children.length };
  } finally { await client.end(); }
}
async function main() {
  assert.equal(process.env.NODE_ENV, 'test'); const mode = process.argv[2], maintenance = process.env.CANVAS_NATIVE_TEST_ADMIN_URL;
  assert(maintenance); assert(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true');
  assert.equal(adminUrl(maintenance).password, '', 'The disposable CI service must not export runtime database credentials.');
  if (mode === 'create') {
    assert(process.env.RUNNER_TEMP && process.env.GITHUB_ENV && path.isAbsolute(process.env.GITHUB_ENV));
    const result = await createNativeCiDatabase(maintenance, process.env.RUNNER_TEMP);
    try {
      await appendFile(process.env.GITHUB_ENV, `CANVAS_NATIVE_TEST_DATABASE_URL=${result.connectionString}\nCANVAS_NATIVE_TEST_RUN_ID=${result.receipt.runId}\nCANVAS_NATIVE_TEST_DATABASE_RECEIPT=${result.receiptFile}\n`);
    } catch (error) { await cleanupNativeCiDatabase(maintenance, result.receiptFile); throw error; }
    console.log(JSON.stringify({ suite: 'native-api-sdk-ci-database', created: true, database: result.receipt.databaseName }));
  } else {
    assert.equal(mode, 'cleanup');
    if (!process.env.CANVAS_NATIVE_TEST_DATABASE_RECEIPT) { console.log(JSON.stringify({ suite: 'native-api-sdk-ci-database', allocationReceiptAbsent: true })); return; }
    const result = await cleanupNativeCiDatabase(maintenance, process.env.CANVAS_NATIVE_TEST_DATABASE_RECEIPT);
    console.log(JSON.stringify({ suite: 'native-api-sdk-ci-database', ...result })); assert(result.noLeaks, 'Native test resources leaked before cleanup.');
  }
}
if (path.basename(process.argv[1] ?? '') === 'native-api-sdk-ci-database.ts') main().catch(() => {
  process.exitCode = 1; console.error('Native API/SDK CI database operation failed.');
});
