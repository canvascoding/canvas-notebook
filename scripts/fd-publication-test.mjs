import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = process.cwd();
const sourceFile = path.join(root, 'app/lib/files/fd-publication.ts');
const source = fs.readFileSync(sourceFile, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const sourceHash = crypto.createHash('sha256').update(source).digest('hex');

/** One identical actual API matrix on both platforms; source is never mocked. */
function primitives(api) {
  const report = { platform: process.platform, arch: process.arch, node: process.version, pid: process.pid,
    uid: process.geteuid(), backend: api.backend, families: [], closed: false, fixtureRemoved: false };
  assert.equal(api.apiVersion, 1); assert(Object.isFrozen(api));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fd-backend-')); fs.chmodSync(root, 0o700);
  report.fixture = root; const birth = fs.lstatSync(root); const fds = new Set();
  const owned = fd => { fds.add(fd); return fd; };
  const close = fd => { fs.closeSync(fd); fds.delete(fd); };
  const denied = (operation, codes) => assert.throws(operation, error => {
    assert.equal(error.name, 'FdPublicationError'); assert(!error.message.includes(root)); assert.equal(error.cause, undefined);
    assert.equal(Object.keys(error).sort().join(','), 'code,name'); return codes.includes(error.code);
  });
  const C = fs.constants;
  const privateProfile = fd => { const info = fs.fstatSync(fd, { bigint: true }); return { dev: info.dev.toString(), ino: info.ino.toString(), uid: Number(info.uid), mode: 0o600 }; };
  try {
    const source = path.join(root, 'source'), target = path.join(root, 'target'); fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(target, { mode: 0o700 });
    fs.mkdirSync(path.join(source, 'child'), { mode: 0o700 });
    const sourceFd = owned(fs.openSync(source, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW));
    const targetFd = owned(fs.openSync(target, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW));
    const file = owned(api.openFileAt(sourceFd, 'content.tmp', 'private-wx')); fs.writeSync(file, Buffer.from('Native FD äöü 🦊\n'));
    fs.fchmodSync(file, 0o644); fs.fsyncSync(file); const original = fs.fstatSync(file); close(file);
    fs.renameSync(source, source + '-pinned'); fs.renameSync(target, target + '-pinned');
    fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(target, { mode: 0o700 }); fs.mkdirSync(path.join(source, 'child'), { mode: 0o700 });
    fs.writeFileSync(path.join(source, 'content.tmp'), 'Peer alias', { mode: 0o600 });
    const child = owned(api.openDirectoryAt(sourceFd, 'child')); assert.equal(fs.fstatSync(child).ino, fs.statSync(path.join(source + '-pinned', 'child')).ino);
    assert.notEqual(fs.fstatSync(child).ino, fs.statSync(path.join(source, 'child')).ino);
    api.mkdirAt(targetFd, 'created', 0o755); assert(fs.statSync(path.join(target + '-pinned', 'created')).isDirectory()); assert(!fs.existsSync(path.join(target, 'created')));
    api.linkAt(sourceFd, 'content.tmp', targetFd, 'published'); assert.equal(fs.statSync(path.join(target + '-pinned', 'published')).ino, original.ino);
    assert.equal(fs.readFileSync(path.join(target + '-pinned', 'published'), 'utf8'), 'Native FD äöü 🦊\n'); assert(!fs.existsSync(path.join(target, 'published')));
    assert.equal(fs.readFileSync(path.join(source, 'content.tmp'), 'utf8'), 'Peer alias');
    report.families.push('real Rename/PeerAlias, pinned open/mkdir/link, same inode/bytes, no peer mutation');

    denied(() => api.linkAt(sourceFd, 'content.tmp', targetFd, 'published'), ['EEXIST']);
    denied(() => api.mkdirAt(targetFd, 'created', 0o700), ['EEXIST']);
    const record = owned(api.openFileAt(sourceFd, 'record.pending', 'private-wx')); const expected = privateProfile(record);
    fs.writeSync(record, Buffer.from('private record')); fs.fsyncSync(record);
    denied(() => api.openFileAt(sourceFd, 'record.pending', 'private-wx'), ['EEXIST']);
    api.linkAt(sourceFd, 'record.pending', sourceFd, 'record.final'); api.unlinkFileAt(sourceFd, 'record.pending', expected); fs.fsyncSync(sourceFd);
    assert.equal(fs.fstatSync(record).nlink, 1); assert.equal(fs.statSync(path.join(source + '-pinned', 'record.final')).ino, Number(expected.ino));
    assert(!api.hasExactNameAt(sourceFd, 'record.pending')); assert(api.hasExactNameAt(sourceFd, 'record.final'));
    const read = owned(api.openFileAt(sourceFd, 'record.final', 'readonly')); const bytes = Buffer.alloc(14); assert.equal(fs.readSync(read, bytes, 0, bytes.length, 0), bytes.length); assert.equal(bytes.toString(), 'private record');
    denied(() => api.unlinkFileAt(sourceFd, 'record.final', { ...expected, ino: (BigInt(expected.ino) + 1n).toString() }), ['FD_PUBLICATION_PROFILE_CHANGED']);
    denied(() => api.unlinkFileAt(sourceFd, 'content.tmp', expected), ['FD_PUBLICATION_PROFILE_CHANGED']);
    report.families.push('exclusive creation, private wx/read/fsync/record link/unlink and foreign inode refusal');

    fs.writeFileSync(path.join(source + '-pinned', 'Camel.json'), 'case', { mode: 0o600 });
    assert(api.hasExactNameAt(sourceFd, 'Camel.json')); assert(!api.hasExactNameAt(sourceFd, 'camel.json')); assert(!api.hasExactNameAt(sourceFd, 'absent'));
    fs.symlinkSync('child', path.join(source + '-pinned', 'symlink')); denied(() => api.openDirectoryAt(sourceFd, 'symlink'), ['ELOOP', 'ENOTDIR']);
    denied(() => api.openFileAt(sourceFd, 'symlink', 'readonly'), ['ELOOP']);
    assert.equal(spawnSync('mkfifo', [path.join(source + '-pinned', 'fifo')]).status, 0);
    denied(() => api.openDirectoryAt(sourceFd, 'fifo'), ['ENOTDIR']); denied(() => api.openFileAt(sourceFd, 'fifo', 'readonly'), ['FD_PUBLICATION_NON_REGULAR']);
    for (const name of ['symlink', 'fifo', 'child']) {
      denied(() => api.linkAt(sourceFd, name, targetFd, 'bad'), ['FD_PUBLICATION_NON_REGULAR']);
      denied(() => api.unlinkFileAt(sourceFd, name, expected), ['FD_PUBLICATION_NON_REGULAR']);
    }
    fs.symlinkSync('never-follow', path.join(target + '-pinned', 'symlink'));
    denied(() => api.linkAt(sourceFd, 'content.tmp', targetFd, 'symlink'), ['EEXIST']); assert(fs.lstatSync(path.join(target + '-pinned', 'symlink')).isSymbolicLink());
    report.families.push('exact names, symlink/FIFO/directory refusal, public mode644 regular source accepted');

    for (const fd of [NaN, Infinity, -1, 0, 2, 3.5, 2_147_483_648, '18', {}]) {
      denied(() => api.openDirectoryAt(fd, 'child'), ['FD_PUBLICATION_INVALID_INPUT']);
      denied(() => api.mkdirAt(fd, 'absent', 0o700), ['FD_PUBLICATION_INVALID_INPUT']);
      denied(() => api.linkAt(fd, 'content.tmp', targetFd, 'absent'), ['FD_PUBLICATION_INVALID_INPUT']);
    }
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'bad\u0000name', '\ud800', 'ä'.repeat(128), {}]) denied(() => api.mkdirAt(targetFd, name, 0o700), ['FD_PUBLICATION_INVALID_INPUT']);
    denied(() => api.mkdirAt(targetFd, 'absent', 0o777), ['FD_PUBLICATION_INVALID_INPUT']); denied(() => api.openFileAt(sourceFd, 'record.final', 'write'), ['FD_PUBLICATION_INVALID_INPUT']);
    denied(() => api.openDirectoryAt(sourceFd, 'child', 'extra'), ['FD_PUBLICATION_INVALID_INPUT']);
    denied(() => api.unlinkFileAt(sourceFd, 'record.final', { ...expected, extra: 'private' }), ['FD_PUBLICATION_INVALID_INPUT']);
    let touched = false; const getter = { ...expected }; Object.defineProperty(getter, 'ino', { enumerable: true, get() { touched = true; return expected.ino; } });
    denied(() => api.unlinkFileAt(sourceFd, 'record.final', getter), ['FD_PUBLICATION_INVALID_INPUT']); assert.equal(touched, false);
    for (const key of ['dev', 'ino']) {
      let coerced = false;
      denied(() => api.unlinkFileAt(sourceFd, 'record.final', { ...expected,
        [key]: { toString() { coerced = true; return expected[key]; } } }), ['FD_PUBLICATION_INVALID_INPUT']);
      assert.equal(coerced, false);
    }
    report.families.push('strict scalar/arity/component/profile parsing and no getter or object coercion');

    const unsafe = path.join(root, 'unsafe'); fs.mkdirSync(unsafe, { mode: 0o700 }); fs.chmodSync(unsafe, 0o777);
    const unsafeFd = owned(fs.openSync(unsafe, C.O_RDONLY | C.O_DIRECTORY)); denied(() => api.mkdirAt(unsafeFd, 'absent', 0o700), ['FD_PUBLICATION_NAMESPACE_CHANGED']);
    denied(() => api.mkdirAt(read, 'absent', 0o700), ['FD_PUBLICATION_NAMESPACE_CHANGED']);
    const dead = fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); fs.closeSync(dead);
    denied(() => api.openDirectoryAt(dead, 'child'), ['EBADF']); denied(() => api.openFileAt(dead, 'child', 'readonly'), ['EBADF']);
    denied(() => api.mkdirAt(dead, 'child', 0o700), ['EBADF']); denied(() => api.linkAt(dead, 'child', targetFd, 'absent'), ['EBADF']);
    denied(() => api.unlinkFileAt(dead, 'record.final', expected), ['EBADF']); denied(() => api.hasExactNameAt(dead, 'child'), ['EBADF']);
    report.families.push('unsafe directory and actual closed/non-directory FD refusal');
    const wide = path.join(root, 'bounded-scan'); fs.mkdirSync(wide, { mode: 0o700 });
    for (let index = 0; index <= 100_000; index++) fs.writeFileSync(path.join(wide, `entry-${index}`), '', { mode: 0o600, flag: 'wx' });
    const wideFd = owned(fs.openSync(wide, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW));
    denied(() => api.hasExactNameAt(wideFd, 'absent'), ['FD_PUBLICATION_SCAN_LIMIT']);
    report.families.push('actual 100001-entry directory exceeds bounded exact-name scan');
    report.passed = true;
  } finally {
    for (const fd of [...fds].reverse()) close(fd); report.closed = true;
    const after = fs.lstatSync(root); assert.equal(after.ino, birth.ino); assert.equal(after.dev, birth.dev); assert.equal(after.uid, report.uid);
    fs.rmSync(root, { recursive: true, force: false }); report.fixtureRemoved = !fs.existsSync(root);
  }
  return report;
}

// This fresh process calls the original addon before any TS wrapper can freeze
// its exports. Native argument validation must never silently truncate names.
function rawAddonChecks(addon) {
  assert(Object.isFrozen(addon)); assert(!Object.isExtensible(addon));
  for (const key of Reflect.ownKeys(addon)) {
    const descriptor = Object.getOwnPropertyDescriptor(addon, key);
    assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fd-raw-')); fs.chmodSync(root, 0o700);
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const name of ['a'.repeat(256), 'ä'.repeat(128), '\ud800', 'bad\u0000name']) {
      const denied = operation => assert.throws(operation, error => error.code === 'FD_PUBLICATION_INVALID_INPUT');
      denied(() => addon.openDirectoryAt(fd, name)); denied(() => addon.openFileAt(fd, name, 'private-wx'));
      denied(() => addon.mkdirAt(fd, name, 0o700)); denied(() => addon.linkAt(fd, name, fd, 'target'));
      denied(() => addon.unlinkFileAt(fd, name, '0', '1', process.geteuid(), 0o600)); denied(() => addon.hasExactNameAt(fd, name));
    }
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.closeSync(fd); fs.rmdirSync(root); }
  return { immutableRawAddon: true, untruncatedRawComponents: true, closed: true, fixtureRemoved: !fs.existsSync(root) };
}

if (process.argv[2] === '--linux-container') {
  const container = 'canvas-local-prod-notebook';
  const inspected = spawnSync('docker', ['inspect', '--format', '{{.Id}} {{index .Config.Labels "io.canvas.local-prod"}} {{.Name}} {{.State.Running}}', container], { encoding: 'utf8' });
  assert.equal(inspected.status, 0); const [id, label, name, running] = inspected.stdout.trim().split(' ');
  assert.match(id, /^[a-f0-9]{64}$/u); assert.equal(label, 'true'); assert.equal(name, '/canvas-local-prod-notebook'); assert.equal(running, 'true');
  const program = `const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),{spawnSync}=require('node:child_process');
    assert.equal(process.platform,'linux');assert.equal(process.geteuid(),1000);
    const loaded=new Module('/tmp/canvas-fd-source.cjs');loaded.filename='/tmp/canvas-fd-source.cjs';loaded.paths=Module._nodeModulePaths('/app');
    loaded._compile(${JSON.stringify(compiled)},loaded.filename);
    const report=(${primitives.toString()})(loaded.exports.getFdPublicationBackend());report.sourceHash=${JSON.stringify(sourceHash)};console.log(JSON.stringify(report));`;
  const result = spawnSync('docker', ['exec', '-i', id, 'node', '--conditions=react-server'], { input: program, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout); const report = JSON.parse(result.stdout.trim()); assert(report.passed && report.closed && report.fixtureRemoved);
  console.log(JSON.stringify({ containerId: id, ...report }));
} else {
  assert.equal(process.argv[2], undefined); const loaded = new Module(sourceFile); loaded.filename = sourceFile; loaded.paths = Module._nodeModulePaths(path.dirname(sourceFile));
  loaded._compile(compiled, sourceFile);
  const report = primitives(loaded.exports.getFdPublicationBackend()); report.sourceHash = sourceHash;
  if (process.platform === 'darwin') {
    const rawBinary = path.join(root, `native/fd-publication/darwin-${process.arch}/fd-publication.node`);
    const rawProgram = `const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');console.log(JSON.stringify((${rawAddonChecks.toString()})(require(${JSON.stringify(rawBinary)}))));`;
    const raw = spawnSync(process.execPath, ['-e', rawProgram], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(raw.status, 0, raw.stderr); assert(JSON.parse(raw.stdout).immutableRawAddon);
    report.families.push('fresh raw addon immutable before TS load; total UTF8/UTF16 length validation prevents truncation');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fd-manifest-')); fs.chmodSync(sandbox, 0o700);
    const relative = `native/fd-publication/darwin-${process.arch}`;
    const output = path.join(sandbox, relative); fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    const sandboxSource = path.join(sandbox, 'tools/native-fs/fd-publication.c');
    fs.mkdirSync(path.dirname(sandboxSource), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(root, 'tools/native-fs/fd-publication.c'), sandboxSource);
    const buildScript = path.join(root, 'scripts/build-fd-publication.mjs');
    const childProgram = `const fs=require('node:fs'),Module=require('node:module');const m=new Module(${JSON.stringify(sourceFile)});m.filename=${JSON.stringify(sourceFile)};m.paths=Module._nodeModulePaths(require('node:path').dirname(m.filename));m._compile(${JSON.stringify(compiled)},m.filename);try{m.exports.getFdPublicationBackend();process.exitCode=1}catch(e){console.log(JSON.stringify({name:e.name,code:e.code,cause:e.cause}));}`;
    try {
      for (const variant of ['missing', 'platform', 'arch', 'api', 'source', 'binary', 'extra', 'duplicate', 'symlink']) {
        fs.rmSync(output, { recursive: true, force: true }); fs.cpSync(path.join(root, relative), output, { recursive: true });
        const file = path.join(output, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (variant === 'missing') fs.unlinkSync(file);
        else if (variant === 'source' || variant === 'binary') fs.appendFileSync(path.join(output, variant === 'source' ? 'source.c' : 'fd-publication.node'), 'drift');
        else if (variant === 'symlink') { fs.renameSync(file, file + '.actual'); fs.symlinkSync('manifest.json.actual', file); }
        else if (variant === 'duplicate') fs.writeFileSync(file, `{"version":1,"version":1,${JSON.stringify(manifest).slice(1)}`);
        else { if (variant === 'platform') manifest.platform = 'linux'; if (variant === 'arch') manifest.arch = 'foreign'; if (variant === 'api') manifest.apiVersion = 99; if (variant === 'extra') manifest.extra = 'private'; fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n'); }
        const result = spawnSync(process.execPath, ['--conditions=react-server', '-e', childProgram], { env: { ...process.env, CANVAS_APP_ROOT: sandbox }, encoding: 'utf8', timeout: 10_000 });
        assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout); assert.equal(value.name, 'FdPublicationError'); assert.equal(value.cause, undefined);
        const verify = spawnSync(process.execPath, [buildScript, 'verify'], { cwd: sandbox, encoding: 'utf8', timeout: 10_000 });
        assert.notEqual(verify.status, 0, `Build verification accepted ${variant}`);
      }
      report.families.push('actual fresh-process load rejects missing/foreign/corrupt/aliased manifests and binary/source drift');
      fs.rmSync(output, { recursive: true, force: true }); fs.cpSync(path.join(root, relative), output, { recursive: true });
      const before = fs.readFileSync(path.join(output, 'fd-publication.node'));
      assert.equal(spawnSync(process.execPath, [buildScript, 'verify'], { cwd: sandbox, encoding: 'utf8', timeout: 10_000 }).status, 0);
      fs.writeFileSync(sandboxSource, '#error intentional owned build failure\n', { mode: 0o600 });
      const refusedBuild = spawnSync(process.execPath, [buildScript], { cwd: sandbox, encoding: 'utf8', timeout: 35_000 });
      assert.notEqual(refusedBuild.status, 0); assert(refusedBuild.stderr.includes('intentional owned build failure'));
      assert.deepEqual(fs.readFileSync(path.join(output, 'fd-publication.node')), before);
      assert(!fs.readdirSync(output).some(name => name.includes('.pending-')));
      report.families.push('actual builder verification rejects negatives; compiler failure preserves artifact and closes private pending');
    } finally { fs.rmSync(sandbox, { recursive: true, force: false }); }
  }
  console.log(JSON.stringify(report));
}
