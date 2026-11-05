/** Add physical sources only to an existing synthetic, source-verified local
 * large-workspace fixture. No database writes or production endpoints. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'dotenv';
import { Client } from 'pg';

const [manifestPath, runtimePath, proofPath] = process.argv.slice(2);
const verifyOnly = process.argv[5] === '--verify';
assert(process.argv[5] === undefined || verifyOnly);
assert(manifestPath && runtimePath && proofPath);
const report = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
const proof = JSON.parse(await fs.readFile(proofPath, 'utf8'));
assert.equal(report.baseURL, 'http://127.0.0.1:3100');
assert.equal(report.documents.length, 300); assert.equal(report.expectedPreview, 'ready');
if (verifyOnly) assert.equal(report.physicalSources?.length, 50);
assert.match(report.runId, /^[a-f0-9-]{36}$/u);
const { stdout } = await promisify(execFile)('docker', ['inspect', 'canvas-local-prod-notebook']);
const [container] = JSON.parse(stdout);
assert.equal(container.Image, proof.image);
assert.equal(container.Mounts.find(mount => mount.Destination === '/data')?.Source, runtime.dataPath);
const state = path.join(os.homedir(), '.local/state/canvas-local-team-seat');
const dataPath = await fs.realpath(runtime.dataPath);
assert.match(runtime.nonce, /^[a-f0-9]{32}$/u);
assert.equal(dataPath, await fs.realpath(path.join(state, 'mcp-bounded-preview', runtime.nonce, 'data')));
assert.equal(runtime.databaseName, `canvas_mcp_bounded_${runtime.nonce}`);
const env = parse(await fs.readFile(path.join(state, 'notebook-host-dev.env')));
const database = new URL(env.DATABASE_URL);
assert(['127.0.0.1', 'localhost'].includes(database.hostname)); assert.equal(database.port, '55433');
assert.equal(database.pathname, '/canvas_notebook');
database.pathname = `/${runtime.databaseName}`;
const client = new Client({ connectionString: database.href });
let row;
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  assert.equal((await client.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker, `canvas-mcp-bounded-fixture:${runtime.nonce}`);
  const selected = await client.query(`SELECT w.root_relative_path FROM canvas_workspaces w JOIN "user" u ON u.id=w.owner_user_id
    WHERE w.id=$1 AND w.type='personal' AND w.status='active' AND w.display_name=$2 AND u.email=$3`,
  [report.workspaceId, `MCP large preview acceptance ${report.runId}`, env.BOOTSTRAP_ADMIN_EMAIL]);
  assert.equal(selected.rowCount, 1, 'Only the original bootstrap-owned synthetic workspace may be seeded.');
  row = selected.rows[0]; await client.query('COMMIT');
} finally { await client.end(); }
assert.equal(typeof row.root_relative_path, 'string');
assert(!path.isAbsolute(row.root_relative_path) && !row.root_relative_path.split('/').some(part => !part || part === '.' || part === '..'));
const root = path.posix.join('/data', row.root_relative_path);
const fixtureProgram = `
const fs = require('node:fs/promises'), path = require('node:path'), {createHash} = require('node:crypto');
const assert = require('node:assert/strict');
(async () => {
 const [root, documentPath, verify] = process.argv.slice(1);
 assert.equal(await fs.realpath(root), root); assert(root.startsWith('/data/'));
 const sources = [];
 for (let index = 0; index < 50; index++) {
  const name = 'mixed-physical-' + String(index).padStart(3, '0') + '.md', file = path.join(root, name);
  const content = '# Physical source ' + index + '\\n\\n[Stable reference](' + documentPath + ')\\n\\n'
   + 'A physical Markdown source exercises file identity, complete parsing and revalidation.\\n\\n'.repeat(64);
  if (verify !== 'true') {
   try { await fs.writeFile(file, content, {flag:'wx',mode:0o600}); }
   catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const metadata = await fs.lstat(file);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
  assert.equal(await fs.readFile(file,'utf8'),content);
  sources.push({path:name,sha256:createHash('sha256').update(content).digest('hex'),bytes:Buffer.byteLength(content)});
 }
 console.log(JSON.stringify(sources));
})().catch(error => { console.error(error); process.exitCode = 1; });`;
const seeded = await promisify(execFile)('docker', ['exec', 'canvas-local-prod-notebook', 'node', '-e', fixtureProgram,
  root, report.documents[0].path, String(verifyOnly)]);
const sources = JSON.parse(seeded.stdout);
if (verifyOnly) assert.deepEqual(sources, report.physicalSources, 'All original physical hashes must survive acceptance.');
else {
  report.physicalSources = sources;
  await fs.writeFile(manifestPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ fixture: 'mixed-preview', nativeSources: 300, physicalSources: sources.length, verifiedOnly: verifyOnly }));
