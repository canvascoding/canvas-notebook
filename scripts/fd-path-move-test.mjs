import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';

// Exercise the real compiled facade and the original addon in separate
// processes. A successful rename proves no-replace mechanics, not authority,
// source-inode CAS, fsync durability, or the workspace operation lifecycle.
const root = process.cwd();
const sourceFile = path.join(root, 'app/lib/files/fd-publication.ts');
const source = fs.readFileSync(sourceFile, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
const artifactRoot = path.resolve(process.env.CANVAS_APP_ROOT?.trim() || root);
const binaryPath = path.join(artifactRoot, `native/fd-publication/${process.platform}-${process.arch}/fd-publication.node`);
const scriptFile = path.join(root, 'scripts/fd-path-move-test.mjs');
const raw = process.argv[2] === '--raw';
assert(process.argv.length === (raw ? 3 : 2), 'Only the internal --raw mode is supported');
assert(['linux', 'darwin'].includes(process.platform), 'A supported actual native platform is required');

function loadFacade() {
  const loaded = new Module(sourceFile);
  loaded.filename = sourceFile;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourceFile));
  loaded._compile(compiled, sourceFile);
  assert.equal(typeof loaded.exports.getFdPathMoveBackend, 'function');
  assert.throws(() => loaded.exports.getFdPathMoveBackend('extra'), error => error.code === 'FD_PUBLICATION_INVALID_INPUT');
  return loaded.exports.getFdPathMoveBackend();
}

function checkShape(api, originalAddon) {
  const methods = ['openDirectoryAt', 'openFileAt', 'mkdirAt', 'linkAt', 'unlinkFileAt', 'hasExactNameAt', 'renameNoReplaceAt', 'listDirectoryAt'];
  const keys = originalAddon ? [...methods, 'apiVersion', 'napiVersion', 'platform', 'arch'] : ['apiVersion', 'backend', 'renameNoReplaceAt'];
  assert.deepEqual(Reflect.ownKeys(api).sort(), keys.sort());
  assert(Object.isFrozen(api));
  assert(!Object.isExtensible(api));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(api, key);
    assert(descriptor?.enumerable && 'value' in descriptor);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
  }
  assert.equal(api.apiVersion, originalAddon ? 3 : 1);
  assert.equal(typeof api.renameNoReplaceAt, 'function');
  if (originalAddon) {
    assert.equal(api.napiVersion, 8);
    assert.equal(api.platform, process.platform);
    assert.equal(api.arch, process.arch);
    for (const method of methods) assert.equal(typeof api[method], 'function');
  } else assert.equal(api.backend, `${process.platform}-node-api8`);
}

function fingerprint(filename) {
  const info = fs.lstatSync(filename, { bigint: true });
  const common = { dev: info.dev.toString(), ino: info.ino.toString(), uid: info.uid.toString(),
    mode: info.mode.toString(), nlink: info.nlink.toString() };
  if (info.isFile()) return { ...common, kind: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') };
  if (info.isDirectory()) return { ...common, kind: 'directory', entries: fs.readdirSync(filename).sort().map(name => [name, fingerprint(path.join(filename, name))]) };
  if (info.isSymbolicLink()) return { ...common, kind: 'symlink', target: fs.readlinkSync(filename) };
  return { ...common, kind: 'special' };
}

function removeOwnedFixture(directory, birth) {
  const current = fs.lstatSync(directory, { bigint: true });
  assert(current.isDirectory());
  assert.equal(current.dev, birth.dev);
  assert.equal(current.ino, birth.ino);
  assert.equal(current.uid, BigInt(process.geteuid()));
  assert.equal(current.mode & 0o777n, 0o700n);
  fs.rmSync(directory, { recursive: true, force: false });
  assert(!fs.existsSync(directory));
}

// Workers load the actual pinned facade or raw binary before signalling ready.
// Both then wait on one real shared-memory barrier, with no product test hook.
async function race(apiMode, sourceFd, targetFd, names) {
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workerProgram = `const {parentPort,workerData}=require('node:worker_threads');
    const Module=require('node:module');
    let api;
    if(workerData.raw)api=require(workerData.binaryPath);
    else{const m=new Module(workerData.sourceFile);m.filename=workerData.sourceFile;
      m.paths=Module._nodeModulePaths(require('node:path').dirname(m.filename));
      m._compile(workerData.compiled,m.filename);api=m.exports.getFdPathMoveBackend();}
    parentPort.postMessage({phase:'ready'});
    const gate=new Int32Array(workerData.barrier);
    if(Atomics.wait(gate,0,0,20000)==='timed-out')throw Error('Owned race barrier timed out');
    try{const result=api.renameNoReplaceAt(workerData.sourceFd,workerData.name,workerData.targetFd,'winner');
      if(result!==undefined)throw Error('Unexpected native return');parentPort.postMessage({phase:'done',ok:true,name:workerData.name});}
    catch(error){parentPort.postMessage({phase:'done',ok:false,code:error.code,name:workerData.name,message:error.message});}
    parentPort.close();`;
  const workers = names.map(name => {
    const worker = new Worker(workerProgram, { eval: true, workerData: {
      raw: apiMode, sourceFile, compiled, binaryPath, sourceFd, targetFd, name, barrier,
    } });
    let readyResolve, readyReject, doneResolve, doneReject, exitResolve, exitReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
    const exited = new Promise((resolve, reject) => { exitResolve = resolve; exitReject = reject; });
    // Rejections can occur before the caller reaches the corresponding await.
    ready.catch(() => {}); done.catch(() => {}); exited.catch(() => {});
    let sawReady = false, sawDone = false;
    const reject = error => { readyReject(error); doneReject(error); exitReject(error); };
    const timeout = setTimeout(() => { reject(new Error('Owned move worker timed out')); void worker.terminate(); }, 25_000);
    worker.on('message', message => {
      if (message?.phase === 'ready' && !sawReady) { sawReady = true; readyResolve(); }
      else if (message?.phase === 'done' && sawReady && !sawDone) { sawDone = true; doneResolve(message); }
      else reject(new Error('Unexpected owned move worker message'));
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      clearTimeout(timeout);
      if (code === 0 && sawReady && sawDone) exitResolve();
      else reject(new Error(`Owned move worker exited without a complete result (${code})`));
    });
    return { worker, ready, done, exited, timeout };
  });
  try {
    await Promise.all(workers.map(item => item.ready));
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0, workers.length);
    const results = await Promise.all(workers.map(item => item.done));
    await Promise.all(workers.map(item => item.exited));
    assert.equal(results.filter(item => item.ok).length, 1);
    assert.equal(results.filter(item => !item.ok && item.code === 'EEXIST').length, 1);
    return results;
  } finally {
    for (const item of workers) clearTimeout(item.timeout);
    await Promise.all(workers.map(item => item.worker.terminate()));
  }
}

function manifestChecks() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fd-move-manifest-'));
  fs.chmodSync(fixture, 0o700);
  const birth = fs.lstatSync(fixture, { bigint: true });
  const relative = `native/fd-publication/${process.platform}-${process.arch}`;
  const output = path.join(fixture, relative);
  const builder = path.join(root, 'scripts/build-fd-publication.mjs');
  const originalSource = path.join(root, 'tools/native-fs/fd-publication.c');
  const fixtureSource = path.join(fixture, 'tools/native-fs/fd-publication.c');
  fs.mkdirSync(path.dirname(fixtureSource), { recursive: true, mode: 0o700 });
  fs.copyFileSync(originalSource, fixtureSource);
  const childProgram = `const assert=require('node:assert/strict'),Module=require('node:module');
    const m=new Module(${JSON.stringify(sourceFile)});m.filename=${JSON.stringify(sourceFile)};
    m.paths=Module._nodeModulePaths(require('node:path').dirname(m.filename));
    m._compile(${JSON.stringify(compiled)},m.filename);
    try{m.exports.getFdPathMoveBackend();console.log(JSON.stringify({accepted:true}));}
    catch(error){console.log(JSON.stringify({accepted:false,name:error.name,code:error.code,message:error.message,keys:Object.keys(error).sort(),cause:error.cause}));}`;
  const child = () => {
    const result = spawnSync(process.execPath, ['--conditions=react-server', '-e', childProgram], {
      cwd: fixture, env: { ...process.env, CANVAS_APP_ROOT: fixture }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.signal, null, result.stderr || result.stdout);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim());
  };
  const verify = () => spawnSync(process.execPath, [builder, 'verify'], {
    cwd: fixture, env: { ...process.env, CANVAS_APP_ROOT: fixture }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  const restore = () => {
    fs.rmSync(output, { recursive: true, force: true });
    fs.cpSync(path.join(artifactRoot, relative), output, { recursive: true });
  };
  const report = { platform: process.platform, variants: [], actualPositiveLoad: false, actualPositiveBuildVerify: false,
    fixtureRemoved: false, originalSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(originalSource)).digest('hex') };
  try {
    restore();
    assert.equal(child().accepted, true);
    report.actualPositiveLoad = true;
    const positiveVerify = verify();
    assert.equal(positiveVerify.signal, null, positiveVerify.stderr || positiveVerify.stdout);
    assert.equal(positiveVerify.status, 0, positiveVerify.stderr || positiveVerify.stdout);
    report.actualPositiveBuildVerify = true;
    for (const variant of ['missing', 'platform', 'arch', 'api', 'source', 'binary', 'extra', 'duplicate', 'symlink']) {
      restore();
      const filename = path.join(output, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (variant === 'missing') fs.unlinkSync(filename);
      else if (variant === 'source' || variant === 'binary') fs.appendFileSync(path.join(output, variant === 'source' ? 'source.c' : 'fd-publication.node'), 'owned-negative-fixture-drift');
      else if (variant === 'symlink') { fs.renameSync(filename, filename + '.actual'); fs.symlinkSync('manifest.json.actual', filename); }
      else if (variant === 'duplicate') fs.writeFileSync(filename, `{"version":1,"version":1,${JSON.stringify(manifest).slice(1)}`);
      else {
        if (variant === 'platform') manifest.platform = process.platform === 'linux' ? 'darwin' : 'linux';
        if (variant === 'arch') manifest.arch = 'foreign';
        if (variant === 'api') manifest.apiVersion = 99;
        if (variant === 'extra') manifest.extra = 'owned-negative-fixture';
        fs.writeFileSync(filename, JSON.stringify(manifest, null, 2) + '\n');
      }
      const result = child();
      assert.equal(result.accepted, false, `Move facade accepted ${variant}`);
      assert.equal(result.name, 'FdPublicationError');
      assert.equal(result.message, 'The descriptor operation could not be confirmed.');
      assert.equal(result.cause, undefined);
      assert.deepEqual(result.keys, ['code', 'name']);
      assert.equal(result.code, variant === 'missing' ? 'ENOENT' : variant === 'symlink' ? 'ELOOP' : 'FD_PUBLICATION_MANIFEST_INVALID');
      const refusedVerify = verify();
      assert.equal(refusedVerify.signal, null, refusedVerify.stderr || refusedVerify.stdout);
      assert.notEqual(refusedVerify.status, 0, `Build verification accepted ${variant}`);
      report.variants.push({ variant, code: result.code, actualFreshProcessLoadRefused: true, actualBuildVerifyRefused: true });
    }
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(originalSource)).digest('hex'), report.originalSourceSha256);
  } finally {
    removeOwnedFixture(fixture, birth);
    report.fixtureRemoved = true;
  }
  return report;
}

async function matrix(api, originalAddon) {
  checkShape(api, originalAddon);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fd-path-move-'));
  fs.chmodSync(fixture, 0o700);
  const birth = fs.lstatSync(fixture, { bigint: true });
  const fds = new Set();
  const C = fs.constants;
  const report = { platform: process.platform, arch: process.arch, node: process.version, uid: process.geteuid(),
    pid: process.pid, rawAddon: originalAddon, backend: originalAddon ? `${api.platform}-node-api8` : api.backend,
    sourceSha256, fixture, families: [], observations: {}, closed: false, fixtureRemoved: false };
  const directory = filename => { const fd = fs.openSync(filename, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); fds.add(fd); return fd; };
  const close = fd => { fs.closeSync(fd); fds.delete(fd); };
  const mkdir = filename => fs.mkdirSync(filename, { mode: 0o700 });
  const write = (filename, text = 'move bytes äöü 🦊\n') => fs.writeFileSync(filename, text, { mode: 0o600, flag: 'wx' });
  const absent = filename => assert.throws(() => fs.lstatSync(filename), error => error.code === 'ENOENT');
  const denied = (operation, codes = ['FD_PUBLICATION_INVALID_INPUT']) => assert.throws(operation, error => {
    assert.equal(error.name, originalAddon ? 'Error' : 'FdPublicationError');
    assert.equal(error.message, 'The descriptor operation could not be confirmed.');
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error).sort(), originalAddon ? ['code'] : ['code', 'name']);
    return codes.includes(error.code);
  });
  let external, externalBirth;
  try {
    const from = path.join(fixture, 'source'), to = path.join(fixture, 'target');
    mkdir(from); mkdir(to);
    const fromFd = directory(from), toFd = directory(to);
    write(path.join(from, 'file'));
    const originalFile = fingerprint(path.join(from, 'file'));
    assert.equal(api.renameNoReplaceAt(fromFd, 'file', toFd, 'renamed'), undefined);
    absent(path.join(from, 'file'));
    assert.deepEqual(fingerprint(path.join(to, 'renamed')), originalFile);
    mkdir(path.join(from, 'folder'));
    mkdir(path.join(from, 'folder', 'empty'));
    mkdir(path.join(from, 'folder', 'nested'));
    write(path.join(from, 'folder', 'nested', 'note.md'), '# native folder\n');
    write(path.join(from, 'folder', 'asset.pdf'), '%PDF-owned-fixture\n');
    const originalFolder = fingerprint(path.join(from, 'folder'));
    api.renameNoReplaceAt(fromFd, 'folder', toFd, 'folder-moved');
    absent(path.join(from, 'folder'));
    assert.deepEqual(fingerprint(path.join(to, 'folder-moved')), originalFolder);
    report.families.push('actual file and nonempty directory move preserve every inode, empty directory and byte');

    fs.renameSync(from, from + '-pinned'); fs.renameSync(to, to + '-pinned');
    mkdir(from); mkdir(to);
    write(path.join(from, 'anchored'), 'peer alias source');
    write(path.join(from + '-pinned', 'anchored'), 'original descriptor source');
    const pinned = fingerprint(path.join(from + '-pinned', 'anchored'));
    const peer = fingerprint(path.join(from, 'anchored'));
    api.renameNoReplaceAt(fromFd, 'anchored', toFd, 'anchored-moved');
    assert.deepEqual(fingerprint(path.join(to + '-pinned', 'anchored-moved')), pinned);
    assert.deepEqual(fingerprint(path.join(from, 'anchored')), peer);
    absent(path.join(from + '-pinned', 'anchored'));
    absent(path.join(to, 'anchored-moved'));
    report.families.push('real parent renames and replacement aliases leave operations anchored to the original directory FDs');

    const sourcePath = from + '-pinned', targetPath = to + '-pinned';
    write(path.join(sourcePath, 'collision-source'), 'must survive every collision');
    write(path.join(targetPath, 'occupied-file'), 'existing destination bytes');
    mkdir(path.join(targetPath, 'occupied-directory'));
    write(path.join(targetPath, 'occupied-directory', 'child'), 'existing directory child');
    fs.symlinkSync('unfollowed-target', path.join(targetPath, 'occupied-symlink'));
    fs.linkSync(path.join(sourcePath, 'collision-source'), path.join(targetPath, 'same-inode'));
    for (const name of ['occupied-file', 'occupied-directory', 'occupied-symlink', 'same-inode']) {
      const beforeSource = fingerprint(path.join(sourcePath, 'collision-source'));
      const beforeTarget = fingerprint(path.join(targetPath, name));
      denied(() => api.renameNoReplaceAt(fromFd, 'collision-source', toFd, name), ['EEXIST']);
      assert.deepEqual(fingerprint(path.join(sourcePath, 'collision-source')), beforeSource);
      assert.deepEqual(fingerprint(path.join(targetPath, name)), beforeTarget);
    }
    denied(() => api.renameNoReplaceAt(fromFd, 'collision-source', fromFd, 'collision-source'), ['EEXIST', 'FD_PUBLICATION_INVALID_INPUT']);
    report.families.push('occupied file, directory, dangling symlink, same-inode hardlink and identical path never overwrite or consume source');

    const beforeInvalid = fingerprint(sourcePath), beforeInvalidTarget = fingerprint(targetPath);
    for (const args of [[], [fromFd], [fromFd, 'collision-source'], [fromFd, 'collision-source', toFd], [fromFd, 'collision-source', toFd, 'extra', 'extra']]) {
      denied(() => api.renameNoReplaceAt(...args));
    }
    let coerced = false;
    const object = { valueOf() { coerced = true; return fromFd; }, toString() { coerced = true; return 'name'; } };
    for (const badFd of [NaN, Infinity, -Infinity, -1, 0, 2, 3.5, 2_147_483_648, '18', null, undefined, object, 18n, Symbol('fd')]) {
      denied(() => api.renameNoReplaceAt(badFd, 'collision-source', toFd, 'invalid'));
      denied(() => api.renameNoReplaceAt(fromFd, 'collision-source', badFd, 'invalid'));
    }
    for (const badName of ['', '.', '..', 'a/b', 'a\\b', 'bad\u0000name', 'bad\nname', 'bad\u007fname', '\ud800', '\udc00', 'a'.repeat(256), 'ä'.repeat(128), null, undefined, object, 18, 18n, Symbol('name')]) {
      denied(() => api.renameNoReplaceAt(fromFd, badName, toFd, 'invalid'));
      denied(() => api.renameNoReplaceAt(fromFd, 'collision-source', toFd, badName));
    }
    assert.equal(coerced, false);
    assert.deepEqual(fingerprint(sourcePath), beforeInvalid);
    assert.deepEqual(fingerprint(targetPath), beforeInvalidTarget);
    report.families.push('strict arity, both FD positions, both component positions, UTF8/UTF16 boundaries and no object coercion');

    for (const name of ['a'.repeat(255), 'ä'.repeat(127) + 'a']) {
      write(path.join(sourcePath, name));
      const original = fingerprint(path.join(sourcePath, name));
      api.renameNoReplaceAt(fromFd, name, toFd, name);
      assert.deepEqual(fingerprint(path.join(targetPath, name)), original);
      absent(path.join(sourcePath, name));
    }
    report.families.push('actual 255-byte ASCII and multibyte component boundaries accepted without truncation');

    denied(() => api.renameNoReplaceAt(fromFd, 'absent-source', toFd, 'absent-target'), ['ENOENT']);
    absent(path.join(targetPath, 'absent-target'));
    fs.symlinkSync('collision-source', path.join(sourcePath, 'source-symlink'));
    fs.symlinkSync('missing-source', path.join(sourcePath, 'dangling-source-symlink'));
    assert.equal(spawnSync('mkfifo', [path.join(sourcePath, 'source-fifo')], { timeout: 5_000 }).status, 0);
    write(path.join(sourcePath, 'unsafe-file')); fs.chmodSync(path.join(sourcePath, 'unsafe-file'), 0o666);
    mkdir(path.join(sourcePath, 'unsafe-directory')); fs.chmodSync(path.join(sourcePath, 'unsafe-directory'), 0o777);
    for (const name of ['source-symlink', 'dangling-source-symlink', 'source-fifo', 'unsafe-file', 'unsafe-directory']) {
      const original = fingerprint(path.join(sourcePath, name));
      denied(() => api.renameNoReplaceAt(fromFd, name, toFd, 'rejected-source'), ['FD_PUBLICATION_NON_REGULAR']);
      assert.deepEqual(fingerprint(path.join(sourcePath, name)), original);
      absent(path.join(targetPath, 'rejected-source'));
    }
    report.families.push('missing, live/dangling symlink, FIFO, group/world-writable file and directory sources fail closed');

    mkdir(path.join(fixture, 'unsafe-parent')); fs.chmodSync(path.join(fixture, 'unsafe-parent'), 0o777);
    const unsafeFd = directory(path.join(fixture, 'unsafe-parent'));
    const fileFd = fs.openSync(path.join(sourcePath, 'collision-source'), C.O_RDONLY | C.O_NOFOLLOW); fds.add(fileFd);
    for (const invalidDirectory of [unsafeFd, fileFd]) {
      denied(() => api.renameNoReplaceAt(invalidDirectory, 'collision-source', toFd, 'invalid-parent'), ['FD_PUBLICATION_NAMESPACE_CHANGED']);
      denied(() => api.renameNoReplaceAt(fromFd, 'collision-source', invalidDirectory, 'invalid-parent'), ['FD_PUBLICATION_NAMESPACE_CHANGED']);
    }
    const dead = directory(fixture); close(dead);
    denied(() => api.renameNoReplaceAt(dead, 'collision-source', toFd, 'closed-parent'), ['EBADF']);
    denied(() => api.renameNoReplaceAt(fromFd, 'collision-source', dead, 'closed-parent'), ['EBADF']);
    report.families.push('unsafe directory, regular-file FD and actual closed FD rejected in both parent positions');

    if (process.geteuid() === 0) {
      write(path.join(sourcePath, 'foreign-owned')); fs.chownSync(path.join(sourcePath, 'foreign-owned'), 1, 1);
      const foreign = fingerprint(path.join(sourcePath, 'foreign-owned'));
      denied(() => api.renameNoReplaceAt(fromFd, 'foreign-owned', toFd, 'foreign-target'), ['FD_PUBLICATION_NON_REGULAR']);
      assert.deepEqual(fingerprint(path.join(sourcePath, 'foreign-owned')), foreign);
      absent(path.join(targetPath, 'foreign-target'));
      report.observations.foreignOwnership = 'actual foreign-owned source refused';
    } else report.observations.foreignOwnership = 'not run: changing file ownership requires privilege unavailable to this test';

    write(path.join(sourcePath, 'CaseOnly.txt'), 'case-only source');
    const caseOriginal = fingerprint(path.join(sourcePath, 'CaseOnly.txt'));
    const caseOriginalNames = fs.readdirSync(sourcePath).sort();
    const caseInsensitive = fs.existsSync(path.join(sourcePath, 'caseonly.txt'));
    if (caseInsensitive) {
      let refused = false;
      try { assert.equal(api.renameNoReplaceAt(fromFd, 'CaseOnly.txt', fromFd, 'caseonly.txt'), undefined); }
      catch (error) { assert.equal(error.code, 'EEXIST'); refused = true; }
      const names = fs.readdirSync(sourcePath);
      assert.equal(names.includes('CaseOnly.txt'), refused);
      assert.equal(names.includes('caseonly.txt'), !refused);
      assert.deepEqual(names.sort(), refused ? caseOriginalNames : caseOriginalNames.map(name => name === 'CaseOnly.txt' ? 'caseonly.txt' : name).sort());
      assert.deepEqual(fingerprint(path.join(sourcePath, refused ? 'CaseOnly.txt' : 'caseonly.txt')), caseOriginal);
      report.observations.caseOnlyRename = refused ? 'case-insensitive filesystem: existing alias refused with EEXIST' : 'case-insensitive filesystem: kernel permits exact case-only rename of the original entry; inode and bytes preserved';
    } else {
      api.renameNoReplaceAt(fromFd, 'CaseOnly.txt', fromFd, 'caseonly.txt');
      absent(path.join(sourcePath, 'CaseOnly.txt'));
      assert.deepEqual(fingerprint(path.join(sourcePath, 'caseonly.txt')), caseOriginal);
      assert.deepEqual(fs.readdirSync(sourcePath).sort(), caseOriginalNames.map(name => name === 'CaseOnly.txt' ? 'caseonly.txt' : name).sort());
      report.observations.caseOnlyRename = 'case-sensitive filesystem: vacant exact name moved with original inode';
    }

    if (process.platform === 'linux' && fs.existsSync('/dev/shm') && fs.statSync('/dev/shm', { bigint: true }).dev !== birth.dev) {
      external = fs.mkdtempSync('/dev/shm/canvas-fd-path-move-'); fs.chmodSync(external, 0o700);
      externalBirth = fs.lstatSync(external, { bigint: true });
      const externalFd = directory(external);
      write(path.join(sourcePath, 'cross-device'), 'must not become copy/delete');
      const crossDevice = fingerprint(path.join(sourcePath, 'cross-device'));
      denied(() => api.renameNoReplaceAt(fromFd, 'cross-device', externalFd, 'cross-device'), ['EXDEV']);
      assert.deepEqual(fingerprint(path.join(sourcePath, 'cross-device')), crossDevice);
      absent(path.join(external, 'cross-device'));
      close(externalFd); removeOwnedFixture(external, externalBirth); external = undefined;
      report.observations.crossDevice = 'actual distinct-dev /dev/shm target refused with EXDEV; source preserved';
    } else report.observations.crossDevice = 'not run: no available distinct-dev /dev/shm target on this platform';

    for (const kind of ['file', 'directory']) {
      const raceRoot = path.join(fixture, `race-${kind}`); mkdir(raceRoot);
      const raceTarget = path.join(raceRoot, 'target'); mkdir(raceTarget);
      const raceFd = directory(raceRoot), raceTargetFd = directory(raceTarget);
      const names = ['candidate-a', 'candidate-b'];
      for (const name of names) {
        if (kind === 'directory') { mkdir(path.join(raceRoot, name)); write(path.join(raceRoot, name, 'child'), name); }
        else write(path.join(raceRoot, name), name);
      }
      const originals = new Map(names.map(name => [name, fingerprint(path.join(raceRoot, name))]));
      const results = await race(originalAddon, raceFd, raceTargetFd, names);
      const winner = results.find(item => item.ok).name, loser = results.find(item => !item.ok).name;
      absent(path.join(raceRoot, winner));
      assert.deepEqual(fingerprint(path.join(raceTarget, 'winner')), originals.get(winner));
      assert.deepEqual(fingerprint(path.join(raceRoot, loser)), originals.get(loser));
      close(raceTargetFd); close(raceFd);
      report.families.push(`simultaneous actual 2-worker ${kind} race: exactly one winner and one EEXIST; both original objects accounted for`);
    }
    report.passed = true;
  } finally {
    for (const fd of [...fds].reverse()) close(fd);
    report.closed = true;
    if (external) {
      removeOwnedFixture(external, externalBirth);
    }
    removeOwnedFixture(fixture, birth);
    report.fixtureRemoved = true;
  }
  return report;
}

if (raw) {
  // No facade module has been evaluated in this process before this require.
  const addon = createRequire(path.join(artifactRoot, 'package.json'))(binaryPath);
  console.log(JSON.stringify(await matrix(addon, true)));
} else {
  const facadeReport = await matrix(loadFacade(), false);
  const child = spawnSync(process.execPath, ['--conditions=react-server', scriptFile, '--raw'], {
    cwd: root, env: process.env, encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.signal, null, child.stderr || child.stdout);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const rawReport = JSON.parse(child.stdout.trim());
  assert(rawReport.passed && rawReport.closed && rawReport.fixtureRemoved && rawReport.rawAddon);
  assert.equal(rawReport.sourceSha256, sourceSha256);
  const manifests = manifestChecks();
  console.log(JSON.stringify({ passed: true, sourceSha256, facade: facadeReport, rawAddon: rawReport, manifests }));
}
