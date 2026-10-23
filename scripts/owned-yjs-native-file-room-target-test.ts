/** Metadata/FS/process guard only. No real App build, Parent guard, PG or browser proof. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OwnedYjsBuildProof, OwnedYjsReceipt } from './lib/owned-yjs-authority-qa';
import { ownedNativeFileRoomReceiptIdentity, requireOwnedNativeFileRoomTarget } from './lib/owned-yjs-native-file-room-target';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const started = (pid: number) => execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5_000 }).trim();
const assertion = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ERR_ASSERTION';
const toyProgram = `
const net=require('node:net'); const servers=[];
function listen(id){const server=net.createServer(socket=>socket.destroy());servers.push(server);
server.once('error',()=>process.exit(1));server.listen(0,'127.0.0.1',()=>process.send({id,port:server.address().port}));}
process.on('message',async message=>{try{
if(message.command==='cwd'){process.chdir(message.path);process.send({id:message.id,ok:true});}
else if(message.command==='listen')listen(message.id);
else if(message.command==='stop'){await Promise.all(servers.map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));process.disconnect();}
}catch{process.exit(1);}}); listen(0);`;

async function toyListener(repo: string) {
  const child = spawn(process.execPath, ['-e', toyProgram], { cwd: repo, env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let nextId = 0;
  const receive = (id: number, send?: () => void) => new Promise<{ port?: number }>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Owned toy listener response timed out.')), 5_000);
    const message = (value: unknown) => {
      if (value && typeof value === 'object' && 'id' in value && value.id === id) {
        finish(undefined, { port: 'port' in value && typeof value.port === 'number' ? value.port : undefined });
      }
    };
    const failure = () => finish(new Error('Owned toy listener failed before its response.'));
    const finish = (error?: Error, value?: { port?: number }) => {
      clearTimeout(timeout); child.off('message', message); child.off('error', failure); child.off('exit', failure);
      if (error) reject(error); else resolve(value!);
    };
    child.on('message', message); child.once('error', failure); child.once('exit', failure); send?.();
  });
  const request = (command: 'cwd' | 'listen', targetPath?: string) => {
    const id = ++nextId;
    return receive(id, () => child.send({ id, command, path: targetPath }));
  };
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.send({ command: 'stop' });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned toy listener exit is unconfirmed.')), 5_000);
      })]);
    } catch (error) {
      // Only this retained spawn handle; never a searched or caller-supplied PID.
      child.kill('SIGKILL'); await closed; throw error;
    } finally { if (timer) clearTimeout(timer); }
    assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
  };
  try {
    const ready = await receive(0); assert(child.pid && ready.port && ready.port >= 1024);
    return { pid: child.pid, port: ready.port, start: started(child.pid), request, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Owned toy listener startup/cleanup failed.'); }
    throw error;
  }
}

async function main(): Promise<void> {
  const previousCwd = process.cwd();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-room-target-guard-')));
  await fs.chmod(root, 0o700);
  let toy: Awaited<ReturnType<typeof toyListener>> | undefined, primary: unknown;
  let failed = false, completed = 0;
  try {
    const repo = path.join(root, 'repo'), dataRoot = path.join(root, 'data'), results = path.join(root, 'results');
    const otherCwd = path.join(root, 'other-cwd');
    for (const directory of [repo, dataRoot, results, otherCwd]) await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(repo, 'fixture.txt'), 'Metadata fixture; no compiled application.\n');
    execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['add', 'fixture.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Guard fixture', '-c', 'user.email=guard@example.test', 'commit', '-qm', 'Owned metadata fixture'], { cwd: repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    await fs.mkdir(path.join(repo, '.next'), { mode: 0o700 });
    toy = await toyListener(repo); process.chdir(repo);
    const nonce = randomBytes(16).toString('hex'), marker = randomBytes(24).toString('hex');
    const rootStat = await fs.stat(root), dataStat = await fs.stat(dataRoot);
    const receipt: OwnedYjsReceipt = { version: 1, nonce, fixtureRoot: root, repo, head, buildId: 'metadata-only-fixture',
      sourceFingerprint: sha('declared source metadata only'), buildFingerprint: sha('declared build metadata only'),
      ownerMarker: marker, rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), dataRoot,
      dataDevice: String(dataStat.dev), dataInode: String(dataStat.ino), databaseName: `canvas_yjs_e2e_${nonce}`,
      databaseOid: '12345', databaseOwner: 'metadata-fixture-role', createAcknowledged: true, phase: 'browser', actorId: null,
      uncertain: false, parentPid: process.pid, parentStart: started(process.pid), serverPid: toy.pid, serverStart: toy.start,
      issuerPid: null, issuerDatabaseOid: null, issuerDatabaseOwner: null, issuerDatabaseMarker: null, restartCount: 0,
      port: toy.port, databaseDropped: false, dataRemoved: false, controlPlaneRoot: repo, controlPlaneHead: head, passed: false,
      selectedSpecs: ['tests/workspace-operation-native-delete.spec.ts'], completedSpecs: [],
      activeSpec: 'tests/workspace-operation-native-delete.spec.ts', failurePhase: null };
    // These are explicitly declared metadata. This fixture never computes or
    // claims a source/build fingerprint and never connects to the synthetic URL.
    const proof: OwnedYjsBuildProof = { version: 1, repo, head, sourceFingerprint: receipt.sourceFingerprint,
      buildFingerprint: receipt.buildFingerprint, buildId: receipt.buildId, createdAt: new Date().toISOString() };
    const receiptPath = path.join(root, 'recovery.json'), proofPath = path.join(repo, '.next/yjs-authority-build-proof.json');
    const environment = (value = receipt): NodeJS.ProcessEnv => ({ CANVAS_YJS_AUTHORITY_E2E: '1', E2E_EXTERNAL_SERVER: '1', NODE_ENV: 'production',
      CANVAS_YJS_QA_RECEIPT: path.join(value.fixtureRoot, 'recovery.json'), CANVAS_YJS_QA_RESULTS: path.join(value.fixtureRoot, 'results'),
      CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_MODE: 'external', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      BASE_URL: `http://127.0.0.1:${value.port}`, BETTER_AUTH_BASE_URL: `http://127.0.0.1:${value.port}`,
      DATABASE_URL: `postgresql://${value.databaseOwner}:unused@127.0.0.1:55433/${value.databaseName}`,
      DATA: value.dataRoot, CANVAS_DATA_ROOT: value.dataRoot, CANVAS_INSTANCE_ID: 'metadata-fixture', CANVAS_ORGANIZATION_ID: 'metadata-org',
      BOOTSTRAP_ADMIN_EMAIL: 'owner@example.test', BOOTSTRAP_ADMIN_PASSWORD: 'synthetic-not-authenticated',
      TEST_LOGIN_EMAIL: 'owner@example.test', TEST_LOGIN_PASSWORD: 'synthetic-not-authenticated',
      TEST_SECONDARY_EMAIL: 'peer@example.test', TEST_SECONDARY_PASSWORD: 'synthetic-peer',
      CANVAS_YJS_QA_RESTART_URL: `http://127.0.0.1:${value.port}/unused`, CANVAS_YJS_QA_RESTART_TOKEN: 'synthetic-not-used' });
    const input = () => ({ version: 1 as const, target: { nonce, repo, head, sourceFingerprint: receipt.sourceFingerprint,
      buildFingerprint: receipt.buildFingerprint, buildId: receipt.buildId, receiptIdentity: ownedNativeFileRoomReceiptIdentity(receipt) },
    room: { documentId: `doc-${randomUUID()}`, path: `owned-yjs-restart-${randomUUID()}.md`, generation: 1, expectedWorkspaceId: 'metadata-workspace' },
    expectedSession: { documentSequence: 1, stateProof: `yjs-snapshot-sha256-v1:${sha('metadata-state-only')}`, stateVector: Buffer.from([0]).toString('base64') } });
    const json = (filename: string, value: unknown) => fs.writeFile(filename, JSON.stringify(value), { mode: 0o600 });
    const publish = async (value = receipt, env = environment(value)) => {
      await fs.writeFile(path.join(value.fixtureRoot, '.fixture-owner'), value.ownerMarker, { mode: 0o600 });
      await json(path.join(value.fixtureRoot, 'recovery.json'), value);
      await fs.writeFile(path.join(value.fixtureRoot, 'runtime.env'), Object.entries(env).filter(([key]) => [
        'BASE_URL', 'BETTER_AUTH_BASE_URL', 'DATABASE_URL', 'DATA', 'CANVAS_DATA_ROOT', 'CANVAS_INSTANCE_ID', 'CANVAS_ORGANIZATION_ID',
        'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD', 'TEST_LOGIN_EMAIL', 'TEST_LOGIN_PASSWORD', 'TEST_SECONDARY_EMAIL', 'TEST_SECONDARY_PASSWORD',
        'CANVAS_YJS_QA_RESTART_URL', 'CANVAS_YJS_QA_RESTART_TOKEN'].includes(key)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
    };
    await publish(); await json(proofPath, proof);
    const check = async (name: string, operation: () => Promise<void>) => { await operation(); console.log(`ok ${++completed} - ${name}`); };
    const rejectReceipt = async (patch: Partial<OwnedYjsReceipt>, refreshMetadataIdentity = false) => {
      const changed = { ...receipt, ...patch }, wire = input();
      if (refreshMetadataIdentity) wire.target.receiptIdentity = ownedNativeFileRoomReceiptIdentity(changed);
      await json(receiptPath, changed);
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(wire, environment()), assertion); }
      finally { await json(receiptPath, receipt); }
    };
    await check('genuine private metadata, real Git HEAD and owned toy PID/CWD/listener are accepted', async () => {
      const wire = input(), result = await requireOwnedNativeFileRoomTarget(wire, environment());
      assert.deepEqual(result.input, wire); assert.equal(result.receipt.databaseOid, receipt.databaseOid);
      assert.equal(result.connectionString, environment().DATABASE_URL); assert(Object.isFrozen(result));
      assert(Object.isFrozen(result.input)); assert(Object.isFrozen(result.input.target)); assert(Object.isFrozen(result.input.room));
      assert.equal(result.expectedVectorSha256, createHash('sha256').update(Buffer.from(wire.expectedSession.stateVector, 'base64')).digest('hex'));
    });
    for (const [name, patch] of Object.entries({ phase: { phase: 'preserved' }, uncertain: { uncertain: true },
      nonce: { nonce: randomBytes(16).toString('hex') }, activeSpec: { activeSpec: 'tests/foreign.spec.ts' },
      parentStart: { parentStart: 'foreign start' }, serverStart: { serverStart: 'foreign start' } })) {
      await check(`reject ${name} pin`, () => rejectReceipt(patch, name === 'parentStart' || name === 'serverStart'));
    }
    for (const [name, filename] of [['root', root], ['DATA', dataRoot], ['marker', path.join(root, '.fixture-owner')],
      ['receipt', receiptPath], ['proof', proofPath]] as const) await check(`reject non-private ${name} mode`, async () => {
      const original = (await fs.stat(filename)).mode & 0o777; await fs.chmod(filename, original | 0o044);
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(input(), environment()), assertion); }
      finally { await fs.chmod(filename, original); }
    });
    await check('reject actual marker-byte replacement', async () => {
      await fs.writeFile(path.join(root, '.fixture-owner'), randomBytes(24).toString('hex'));
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(input(), environment()), assertion); }
      finally { await fs.writeFile(path.join(root, '.fixture-owner'), marker); }
    });
    await check('reject marker symlink without following it', async () => {
      const filename = path.join(root, '.fixture-owner'), held = `${filename}.held`; await fs.rename(filename, held); await fs.symlink(held, filename);
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(input(), environment()), error => error instanceof Error && 'code' in error && error.code === 'ELOOP'); }
      finally { await fs.unlink(filename); await fs.rename(held, filename); }
    });
    await check('reject a symlink alias to the actual private root', async () => {
      const alias = path.join(root, 'root-alias'); await fs.symlink(root, alias);
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(input(), { ...environment(), CANVAS_YJS_QA_RECEIPT: path.join(alias, 'recovery.json') }), assertion); }
      finally { await fs.unlink(alias); }
    });
    await check('reject substituted DATA inode at the same path', async () => {
      const held = `${dataRoot}.held`; await fs.rename(dataRoot, held); await fs.mkdir(dataRoot, { mode: 0o700 });
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(input(), environment()), assertion); }
      finally { await fs.rmdir(dataRoot); await fs.rename(held, dataRoot); }
    });
    await check('reject ENV-only URL mismatch', async () => {
      await assert.rejects(requireOwnedNativeFileRoomTarget(input(), { ...environment(), DATABASE_URL: 'postgresql://unused@127.0.0.1:55433/foreign' }), assertion);
    });
    await check('reject coherently published shared database URL', async () => {
      const env = { ...environment(), DATABASE_URL: 'postgresql://unused@127.0.0.1:55433/canvas_notebook' }; await publish(receipt, env);
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(input(), env), assertion); } finally { await publish(); }
    });
    await check('reject changed proof metadata', async () => {
      await json(proofPath, { ...proof, buildFingerprint: sha('foreign proof') });
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(input(), environment()), assertion); } finally { await json(proofPath, proof); }
    });
    await check('reject coherent declared HEAD replacement against the actual Git HEAD', async () => {
      const foreign = 'f'.repeat(40); assert.notEqual(foreign, head); const wire = input(); wire.target.head = foreign;
      const changed = { ...receipt, head: foreign }; wire.target.receiptIdentity = ownedNativeFileRoomReceiptIdentity(changed);
      await json(receiptPath, changed); await json(proofPath, { ...proof, head: foreign });
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(wire, environment()), assertion); }
      finally { await json(receiptPath, receipt); await json(proofPath, proof); }
    });
    await check('reject actual listener process CWD drift', async () => {
      await toy!.request('cwd', otherCwd);
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(input(), environment()), assertion); }
      finally { await toy!.request('cwd', repo); }
    });
    await check('reject a real matching PID/start/CWD that does not own the actual toy listener', async () => {
      const changed = { ...receipt, serverPid: process.pid, serverStart: started(process.pid) }, wire = input();
      wire.target.receiptIdentity = ownedNativeFileRoomReceiptIdentity(changed); await json(receiptPath, changed);
      try {
        await assert.rejects(requireOwnedNativeFileRoomTarget(wire, environment()), error => error instanceof Error
          && 'status' in error && error.status === 1 && error.message.startsWith('Command failed: lsof '));
      } finally { await json(receiptPath, receipt); }
    });
    const digestFailure = (old: string, current: string) => (error: unknown) => assertion(error)
      && error !== null && typeof error === 'object' && 'actual' in error && 'expected' in error
      && new Set([error.actual, error.expected]).has(old) && new Set([error.actual, error.expected]).has(current);
    for (const kind of ['DB', 'Host', 'Root'] as const) await check(`reject coherent ${kind} replacement under all six unchanged header pins`, async () => {
      const wire = input(); let changed: OwnedYjsReceipt;
      if (kind === 'DB') changed = { ...receipt, databaseOid: '12346', databaseOwner: 'foreign-metadata-role' };
      else if (kind === 'Host') {
        const listener = await toy!.request('listen'); assert(listener.port && listener.port !== receipt.port);
        changed = { ...receipt, port: listener.port };
      } else {
        const alternate = path.join(root, 'alternate-root'); await fs.mkdir(alternate, { mode: 0o700 });
        const data = path.join(alternate, 'data'); await fs.mkdir(data, { mode: 0o700 }); await fs.mkdir(path.join(alternate, 'results'), { mode: 0o700 });
        const stat = await fs.stat(alternate), dataStat = await fs.stat(data);
        changed = { ...receipt, fixtureRoot: alternate, rootDevice: String(stat.dev), rootInode: String(stat.ino), dataRoot: data,
          dataDevice: String(dataStat.dev), dataInode: String(dataStat.ino), ownerMarker: randomBytes(24).toString('hex') };
      }
      const changedIdentity = ownedNativeFileRoomReceiptIdentity(changed); assert.notEqual(changedIdentity, wire.target.receiptIdentity);
      await publish(changed);
      try { await assert.rejects(requireOwnedNativeFileRoomTarget(wire, environment(changed)), digestFailure(wire.target.receiptIdentity, changedIdentity)); }
      finally { await publish(); }
    });
    await check('capture nested input and ENV before the first await', async () => {
      const wire = input(), expected = structuredClone(wire), env = environment();
      const pending = requireOwnedNativeFileRoomTarget(wire, env);
      wire.target.nonce = '0'.repeat(32); wire.room.path = 'changed-after-entry.md'; wire.expectedSession.documentSequence = 99;
      wire.expectedSession.stateVector = Buffer.from([2]).toString('base64');
      env.CANVAS_YJS_QA_RECEIPT = '/not-the-private-receipt'; env.DATABASE_URL = 'postgresql://foreign'; env.DATA = '/foreign';
      const result = await pending; assert.deepEqual(result.input, expected); assert.equal(result.connectionString, environment().DATABASE_URL);
      assert.equal(result.expectedVectorSha256, createHash('sha256').update(Buffer.from(expected.expectedSession.stateVector, 'base64')).digest('hex'));
    });
    await check('reject accessors without evaluating them', async () => {
      const wire = input(); let reads = 0;
      Object.defineProperty(wire.room, 'path', { enumerable: true, get() { reads++; return 'forged.md'; } });
      await assert.rejects(requireOwnedNativeFileRoomTarget(wire, environment()), assertion); assert.equal(reads, 0);
    });
  } catch (error) { failed = true; primary = error; }
  finally {
    const errors: unknown[] = [];
    try { await toy?.close(); } catch (error) { errors.push(error); }
    try { process.chdir(previousCwd); } catch (error) { errors.push(error); }
    try { await fs.rm(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(failed ? [primary, ...errors] : errors, 'Owned metadata fixture cleanup failed.');
  }
  if (failed) throw primary;
  assert.equal(process.cwd(), previousCwd); await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  console.log(`COMPLETED ${completed} metadata/FS/process guard cases; toy child closed, CWD restored, private root removed. No PG/Appbuild/browser/Parentguard proof.`);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
