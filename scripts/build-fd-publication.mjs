import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2] ?? 'build';
assert(['build', 'verify'].includes(mode), 'Use build or verify');
const root = process.cwd();
const source = path.join(root, 'tools/native-fs/fd-publication.c');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = filename => {
  const info = fs.lstatSync(filename);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 2 * 1024 * 1024
    && !(info.mode & 0o022), 'Invalid descriptor artifact');
  return fs.readFileSync(filename);
};

if (['linux', 'darwin'].includes(process.platform)) {
  assert(['arm64', 'x64'].includes(process.arch) && Number(process.versions.napi) >= 8, 'Unsupported descriptor runtime');
  if (process.platform === 'linux') assert(fs.statSync('/proc/self/fd').isDirectory(), 'Linux descriptor filesystem is required');
  const output = path.join(root, 'native/fd-publication', `${process.platform}-${process.arch}`);
  const binary = path.join(output, 'fd-publication.node');
  const manifestPath = path.join(output, 'manifest.json');
  const sourceBytes = read(source);
  const verify = () => {
    const text = read(manifestPath).toString('utf8'), manifest = JSON.parse(text);
    assert.equal(JSON.stringify(manifest, null, 2) + '\n', text);
    assert.deepEqual(Object.keys(manifest), ['version', 'apiVersion', 'napiVersion', 'platform', 'arch', 'sourceSha256', 'binarySha256', 'nodeVersion', 'compiler']);
    assert.equal(manifest.version, 1); assert.equal(manifest.apiVersion, 2); assert.equal(manifest.napiVersion, 8);
    assert.equal(manifest.platform, process.platform); assert.equal(manifest.arch, process.arch);
    assert.equal(typeof manifest.nodeVersion, 'string'); assert.equal(typeof manifest.compiler, 'string');
    assert.equal(manifest.sourceSha256, hash(sourceBytes)); assert.equal(manifest.sourceSha256, hash(read(path.join(output, 'source.c'))));
    assert.equal(manifest.binarySha256, hash(read(binary)));
    const addon = createRequire(import.meta.url)(binary);
    const methods = ['openDirectoryAt', 'openFileAt', 'mkdirAt', 'linkAt', 'unlinkFileAt', 'hasExactNameAt', 'renameNoReplaceAt'];
    assert(Object.isFrozen(addon)); assert.equal(Object.getPrototypeOf(addon), Object.prototype);
    assert.equal(Reflect.ownKeys(addon).length, methods.length + 4);
    for (const name of [...methods, 'apiVersion', 'napiVersion', 'platform', 'arch']) {
      const descriptor = Object.getOwnPropertyDescriptor(addon, name);
      assert(descriptor?.enumerable && 'value' in descriptor, 'Invalid native descriptor export');
    }
    assert.equal(addon.apiVersion, 2); assert.equal(addon.napiVersion, 8);
    assert.equal(addon.platform, process.platform); assert.equal(addon.arch, process.arch);
    for (const name of methods) assert.equal(typeof addon[name], 'function');
    assert.equal(manifest.binarySha256, hash(read(binary)));
  };
  if (mode === 'build') {
    fs.mkdirSync(output, { recursive: true, mode: 0o755 });
    assert(fs.lstatSync(output).isDirectory() && !fs.lstatSync(output).isSymbolicLink(), 'Invalid descriptor output directory');
    const candidates = [...new Set([path.resolve(path.dirname(fs.realpathSync(process.execPath)), '../include/node'),
      ...(process.platform === 'linux' ? ['/usr/include/node'] : [])])];
    const headers = candidates.find(candidate => {
      try { return fs.lstatSync(path.join(candidate, 'node_api.h')).isFile(); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    assert(headers, 'The installed Node headers are required; no download fallback');
    const temporary = `${binary}.pending-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    try {
      const compiler = spawnSync('cc', ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
      assert.equal(compiler.status, 0, 'An installed C compiler is required; no installation fallback');
      const result = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DNAPI_VERSION=8',
        ...(process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC']),
        '-I', headers, '-o', temporary, source], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 });
      assert.equal(result.status, 0, result.stderr || 'Descriptor compilation failed');
      fs.chmodSync(temporary, 0o755);
      const manifest = { version: 1, apiVersion: 2, napiVersion: 8, platform: process.platform, arch: process.arch,
        sourceSha256: hash(sourceBytes), binarySha256: hash(read(temporary)), nodeVersion: process.version,
        compiler: compiler.stdout.split('\n')[0].slice(0, 512) };
      fs.copyFileSync(source, path.join(output, 'source.c')); fs.chmodSync(path.join(output, 'source.c'), 0o644);
      fs.renameSync(temporary, binary);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  verify(); console.log(`FD publication: verified ${process.platform}-${process.arch} Node-API8 descriptor addon (native API2).`);
} else {
  // Other platforms retain their existing app build. I04 availability fails
  // closed there; this never selects a path/child/backend fallback.
  console.log('FD publication: unsupported platform; no publication backend.');
}
