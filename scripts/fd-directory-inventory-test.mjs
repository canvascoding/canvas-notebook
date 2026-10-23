import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// This is a directory-name primitive acceptance test. It does not establish
// immutable subtree contents, move authority, journal ownership or durability.
const root = process.cwd();
const sourceFile = path.join(root, 'app/lib/files/fd-publication.ts');
const source = fs.readFileSync(sourceFile, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceSha256 = sha(source);
const nativeSourceSha256 = sha(fs.readFileSync(path.join(root, 'tools/native-fs/fd-publication.c')));
const artifactRoot = path.resolve(process.env.CANVAS_APP_ROOT?.trim() || root);
const binaryPath = path.join(artifactRoot, `native/fd-publication/${process.platform}-${process.arch}/fd-publication.node`);
const binarySha256 = sha(fs.readFileSync(binaryPath));
const scriptFile = path.join(root, 'scripts/fd-directory-inventory-test.mjs');
const raw = process.argv[2] === '--raw';
assert(process.argv.length === (raw ? 3 : 2), 'Only the internal --raw mode is supported');
assert(['linux', 'darwin'].includes(process.platform), 'An actual supported native platform is required');

function loadFacade() {
  const loaded = new Module(sourceFile);
  loaded.filename = sourceFile;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourceFile));
  loaded._compile(compiled, sourceFile);
  assert.equal(typeof loaded.exports.getFdDirectoryInventoryBackend, 'function');
  assert.throws(() => loaded.exports.getFdDirectoryInventoryBackend('extra'), error => error.code === 'FD_PUBLICATION_INVALID_INPUT');
  return loaded.exports.getFdDirectoryInventoryBackend();
}

function checkShape(api, originalAddon) {
  const methods = ['openDirectoryAt', 'openFileAt', 'mkdirAt', 'linkAt', 'unlinkFileAt', 'hasExactNameAt',
    'renameNoReplaceAt', 'listDirectoryAt'];
  const keys = originalAddon ? [...methods, 'apiVersion', 'napiVersion', 'platform', 'arch'] : ['apiVersion', 'backend', 'listDirectoryAt'];
  assert.deepEqual(Reflect.ownKeys(api).sort(), keys.sort());
  assert(Object.isFrozen(api)); assert(!Object.isExtensible(api));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(api, key);
    assert(descriptor?.enumerable && 'value' in descriptor);
    assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false);
  }
  assert.equal(api.apiVersion, originalAddon ? 3 : 1);
  if (originalAddon) {
    assert.equal(api.napiVersion, 8); assert.equal(api.platform, process.platform); assert.equal(api.arch, process.arch);
    for (const method of methods) assert.equal(typeof api[method], 'function');
  } else assert.equal(api.backend, `${process.platform}-node-api8`);
}

function checkNames(value, expected) {
  assert(Array.isArray(value)); assert.equal(Object.getPrototypeOf(value), Array.prototype);
  assert(Object.isFrozen(value)); assert(!Object.isExtensible(value));
  assert.equal(Reflect.ownKeys(value).length, value.length + 1);
  assert.equal(new Set(value).size, value.length);
  for (const [index, name] of value.entries()) {
    assert.equal(typeof name, 'string'); assert(name && name !== '.' && name !== '..');
    assert(!/[\\/\u0000-\u001f\u007f]/u.test(name)); assert(Buffer.byteLength(name) <= 255);
    assert.equal(Buffer.from(name).toString('utf8'), name);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    assert(descriptor?.enumerable && 'value' in descriptor);
    assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false);
  }
  if (expected) assert.deepEqual([...value].sort(), [...expected].sort());
  return value;
}

function removeOwnedFixture(directory, birth) {
  const current = fs.lstatSync(directory, { bigint: true });
  assert(current.isDirectory()); assert.equal(current.dev, birth.dev); assert.equal(current.ino, birth.ino);
  assert.equal(current.uid, BigInt(process.geteuid())); assert.equal(current.mode & 0o777n, 0o700n);
  fs.rmSync(directory, { recursive: true, force: false }); assert(!fs.existsSync(directory));
}

function matrix(api, originalAddon) {
  checkShape(api, originalAddon);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fd-directory-inventory-'));
  fs.chmodSync(fixture, 0o700);
  const birth = fs.lstatSync(fixture, { bigint: true }), fds = new Set(), C = fs.constants;
  const descriptorDirectory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  const descriptorCountBefore = fs.readdirSync(descriptorDirectory).length;
  const report = { platform: process.platform, arch: process.arch, node: process.version, pid: process.pid,
    uid: process.geteuid(), sourceSha256, nativeSourceSha256, binarySha256, rawAddon: originalAddon,
    fixture, families: [], observations: {}, passed: false, closed: false, fixtureRemoved: false,
    descriptorCountBefore, descriptorCountAfter: null, nativeDescriptorsClosed: false };
  const directory = filename => { const fd = fs.openSync(filename, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); fds.add(fd); return fd; };
  const close = fd => { fs.closeSync(fd); fds.delete(fd); };
  const mkdir = filename => fs.mkdirSync(filename, { mode: 0o700 });
  const write = filename => fs.writeFileSync(filename, '', { mode: 0o600, flag: 'wx' });
  const denied = (operation, codes) => assert.throws(operation, error => {
    assert.equal(error.name, originalAddon ? 'Error' : 'FdPublicationError');
    assert.equal(error.message, 'The descriptor operation could not be confirmed.');
    assert.equal(error.cause, undefined); assert(!error.message.includes(fixture));
    assert.deepEqual(Object.keys(error).sort(), originalAddon ? ['code'] : ['code', 'name']);
    return codes.includes(error.code);
  });
  try {
    const original = path.join(fixture, 'source'), pinned = path.join(fixture, 'source-pinned'); mkdir(original);
    const fd = directory(original), identity = fs.fstatSync(fd, { bigint: true });
    for (const name of ['ordinary.md', 'äöü 🦊.md', '日本語.md', 'a'.repeat(255)]) write(path.join(original, name));
    mkdir(path.join(original, 'filled')); write(path.join(original, 'filled', 'child'));
    mkdir(path.join(original, 'empty'));
    fs.symlinkSync('ordinary.md', path.join(original, 'symlink-entry'));
    const fifo = spawnSync('mkfifo', ['-m', '600', path.join(original, 'fifo-entry')], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(fifo.status, 0, fifo.stderr);
    const expected = fs.readdirSync(original);
    fs.renameSync(original, pinned); mkdir(original); write(path.join(original, 'peer-only.md'));
    assert.equal(fs.statSync(pinned, { bigint: true }).ino, identity.ino);
    assert.notEqual(fs.statSync(original, { bigint: true }).ino, identity.ino);
    checkNames(api.listDirectoryAt(fd), expected);
    assert.deepEqual(fs.readdirSync(original), ['peer-only.md']);
    report.families.push('actual renamed-parent FD inventory returns every original name; fresh peer alias remains untouched');

    const emptyFd = directory(path.join(pinned, 'empty'));
    checkNames(api.listDirectoryAt(emptyFd), []);
    checkNames(api.listDirectoryAt(fd), expected); checkNames(api.listDirectoryAt(fd), expected);
    assert(expected.includes('a'.repeat(255)) && expected.some(name => name.includes('🦊')));
    report.families.push('empty frozen array, complete Unicode/max-255-byte names and repeated independent directory cursors');

    const previous = checkNames(api.listDirectoryAt(fd), expected);
    write(path.join(pinned, 'later.md'));
    checkNames(api.listDirectoryAt(fd), [...expected, 'later.md']);
    checkNames(previous, expected);
    report.families.push('a later call observes a new name while the prior frozen array stays unchanged; no filesystem snapshot claim');

    for (const invalid of [undefined, null, true, false, NaN, Infinity, -Infinity, -1, 0, 2, 3.5, 2_147_483_648, '18', {}, []]) {
      denied(() => api.listDirectoryAt(invalid), ['FD_PUBLICATION_INVALID_INPUT']);
    }
    let touched = false;
    denied(() => api.listDirectoryAt({ valueOf() { touched = true; return fd; }, toString() { touched = true; return String(fd); } }),
      ['FD_PUBLICATION_INVALID_INPUT']);
    assert.equal(touched, false);
    denied(() => api.listDirectoryAt(), ['FD_PUBLICATION_INVALID_INPUT']);
    denied(() => api.listDirectoryAt(fd, undefined), ['FD_PUBLICATION_INVALID_INPUT']);
    report.families.push('strict one-scalar FD arity, range and type checks without object coercion');

    const unsafe = path.join(fixture, 'unsafe'); mkdir(unsafe); fs.chmodSync(unsafe, 0o777);
    const unsafeFd = directory(unsafe), regularFd = fs.openSync(path.join(pinned, 'ordinary.md'), C.O_RDONLY | C.O_NOFOLLOW); fds.add(regularFd);
    denied(() => api.listDirectoryAt(unsafeFd), ['FD_PUBLICATION_NAMESPACE_CHANGED']);
    denied(() => api.listDirectoryAt(regularFd), ['FD_PUBLICATION_NAMESPACE_CHANGED']);
    const dead = directory(fixture); close(dead);
    denied(() => api.listDirectoryAt(dead), ['EBADF']);
    report.families.push('actual unsafe, regular-file and closed directory descriptors rejected');

    const bad = path.join(fixture, 'bad-names'); mkdir(bad); const badFd = directory(bad);
    write(path.join(bad, 'valid.md'));
    for (const name of ['bad\nname', 'bad\rname', 'bad\tname', 'bad\\name', 'bad\u0001name', 'bad\u007fname']) {
      const filename = path.join(bad, name); write(filename);
      try { denied(() => api.listDirectoryAt(badFd), ['FD_PUBLICATION_INVALID_INPUT']); }
      finally { fs.unlinkSync(filename); }
      checkNames(api.listDirectoryAt(badFd), ['valid.md']);
    }
    const invalidUtf8 = Buffer.concat([Buffer.from(`${bad}${path.sep}`), Buffer.from([0x66, 0x80, 0xff])]);
    let createdInvalidUtf8 = false;
    try { write(invalidUtf8); createdInvalidUtf8 = true; }
    catch (error) {
      assert(['EINVAL', 'EILSEQ'].includes(error.code), 'Only actual filesystem UTF-8 rejection can replace this case');
      report.observations.invalidFilesystemUtf8 = `filesystem rejected the actual byte name with ${error.code}`;
    }
    if (createdInvalidUtf8) {
      try { denied(() => api.listDirectoryAt(badFd), ['FD_PUBLICATION_INVALID_INPUT']); }
      finally { fs.unlinkSync(invalidUtf8); }
      report.observations.invalidFilesystemUtf8 = 'actual invalid UTF-8 filename created and complete inventory refused without a lossy alias';
    }
    checkNames(api.listDirectoryAt(badFd), ['valid.md']);
    report.families.push('actual forbidden filesystem names and invalid UTF-8 are refused; a partial inventory is never returned');

    const wide = path.join(fixture, 'bounded'); mkdir(wide); const wideFd = directory(wide);
    for (let index = 0; index < 100_000; index++) write(path.join(wide, `entry-${index}`));
    const full = checkNames(api.listDirectoryAt(wideFd)); assert.equal(full.length, 100_000);
    const names = new Set(full);
    for (let index = 0; index < 100_000; index++) assert(names.has(`entry-${index}`));
    const extra = path.join(wide, 'entry-100000'); write(extra);
    denied(() => api.listDirectoryAt(wideFd), ['FD_PUBLICATION_SCAN_LIMIT']);
    fs.unlinkSync(extra); assert.equal(checkNames(api.listDirectoryAt(wideFd)).length, 100_000);
    report.families.push('actual 100000-entry complete inventory succeeds; entry 100001 rejects; a fresh full scan succeeds afterward');
    report.passed = true;
  } finally {
    const errors = [];
    for (const fd of [...fds].reverse()) { try { close(fd); } catch (error) { errors.push(error); } }
    report.closed = fds.size === 0;
    try { removeOwnedFixture(fixture, birth); report.fixtureRemoved = true; } catch (error) { errors.push(error); }
    try {
      report.descriptorCountAfter = fs.readdirSync(descriptorDirectory).length;
      assert.equal(report.descriptorCountAfter, descriptorCountBefore, 'Native directory scans must close their internal descriptors on every outcome.');
      report.nativeDescriptorsClosed = true;
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Owned inventory fixture disposal could not be confirmed.');
  }
  return report;
}

if (raw) {
  // This fresh process never evaluates the TypeScript facade before raw load.
  const addon = createRequire(path.join(artifactRoot, 'package.json'))(binaryPath);
  console.log(JSON.stringify(matrix(addon, true)));
} else {
  // Run the raw process before the first facade evaluation in this parent too.
  const child = spawnSync(process.execPath, ['--conditions=react-server', scriptFile, '--raw'], {
    cwd: root, env: process.env, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(child.signal, null, child.stderr || child.stdout);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const rawReport = JSON.parse(child.stdout.trim());
  assert(rawReport.passed && rawReport.closed && rawReport.fixtureRemoved && rawReport.nativeDescriptorsClosed && rawReport.rawAddon);
  assert.equal(rawReport.sourceSha256, sourceSha256); assert.equal(rawReport.nativeSourceSha256, nativeSourceSha256);
  assert.equal(rawReport.binarySha256, binarySha256);
  const facadeReport = matrix(loadFacade(), false);
  assert.equal(sha(fs.readFileSync(sourceFile)), sourceSha256);
  assert.equal(sha(fs.readFileSync(path.join(root, 'tools/native-fs/fd-publication.c'))), nativeSourceSha256);
  assert.equal(sha(fs.readFileSync(binaryPath)), binarySha256);
  console.log(JSON.stringify({ passed: true, sourceSha256, nativeSourceSha256, binarySha256,
    rawBeforeFacade: true, rawAddon: rawReport, facade: facadeReport }));
}
