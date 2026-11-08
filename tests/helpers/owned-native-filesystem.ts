import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const maximumReadBytes = 8 * 1024 * 1024;

function relativeFixturePath(relative: string): void {
  assert(relative && !relative.startsWith('/') && !relative.includes('\\') && !/[\p{Cc}\p{Cf}]/u.test(relative)
    && !relative.split('/').some(part => ['', '.', '..'].includes(part)));
}

/** Select an immutable container ID only after binding its image and DATA to
 * the caller's actual host mount or private owned-volume control marker. */
async function ownedFilesystemContainer(dataRoot: string): Promise<string | null> {
  const container = process.env.CANVAS_NATIVE_FILE_EVENT_CONTAINER;
  if (!container) return null;
  assert.equal(container, 'canvas-local-prod-notebook');
  assert.equal(process.env.BASE_URL, 'http://127.0.0.1:3100');
  const expectedImage = process.env.CANVAS_NATIVE_FILE_EVENT_IMAGE;
  assert.match(expectedImage ?? '', /^sha256:[a-f0-9]{64}$/u);
  const { stdout } = await execute('docker', ['inspect', container, '--format',
    '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"managed":{{json (index .Config.Labels "io.canvas.local-prod")}},"acceptance":{{json (index .Config.Labels "io.canvas.restore-acceptance")}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}'],
  { timeout: 10_000, maxBuffer: 64 * 1024 });
  const target = JSON.parse(stdout);
  assert.match(target.id ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(target.image, expectedImage); assert.equal(target.running, true); assert.equal(target.managed, 'true');
  assert.deepEqual(target.ports?.['3000/tcp'], [{ HostIp: '127.0.0.1', HostPort: '3100' }]);
  const mounts = target.mounts.filter((entry: { Destination: string }) => entry.Destination === '/data');
  assert.equal(mounts.length, 1);
  const mount = mounts[0];
  if (mount.Type === 'bind') {
    assert.equal(await realpath(mount.Source), await realpath(dataRoot));
  } else {
    assert.equal(mount.Type, 'volume'); assert.equal(mount.RW, true);
    const directory = await lstat(dataRoot);
    assert(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid?.()
      && (directory.mode & 0o077) === 0);
    const markerFile = await open(path.join(dataRoot, '.canvas-owned-acceptance.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let marker: { marker: string };
    try {
      const stat = await markerFile.stat();
      assert(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size <= 4096);
      marker = JSON.parse(await markerFile.readFile('utf8'));
    } finally { await markerFile.close(); }
    const matched = /^canvas-owned-portable-restore:([a-f0-9]{12}):source:[a-f0-9]{40}$/u.exec(marker.marker);
    assert(matched, 'Expected the owned fixture marker, not a guessed volume name.');
    assert.equal(target.acceptance, marker.marker);
    assert.equal(mount.Name, `canvas-restore-qa-${matched[1]}-source-data`);
    const volume = await execute('docker', ['volume', 'inspect', mount.Name], { timeout: 10_000, maxBuffer: 64 * 1024 });
    const metadata = JSON.parse(volume.stdout); assert.equal(metadata.length, 1);
    assert.equal(metadata[0].Name, mount.Name);
    assert.equal(metadata[0].Driver, 'local'); assert.equal(metadata[0].Scope, 'local');
    assert(!metadata[0].Options || Object.keys(metadata[0].Options).length === 0);
    assert.equal(metadata[0].Labels?.['io.canvas.restore-acceptance'], marker.marker);
  }
  return target.id;
}

/** Actual physical UTF-8 bytes, never a native-document API export. The named
 * volume branch does not pretend that the host control directory holds DATA. */
export async function readOwnedFilesystemFixture(input: { dataRoot: string; relativePath: string }): Promise<string> {
  relativeFixturePath(input.relativePath);
  const container = await ownedFilesystemContainer(input.dataRoot);
  let bytes: Buffer;
  if (container) {
    const program = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const value=JSON.parse(process.argv[1]),file=path.resolve('/data',value.relativePath);assert(file.startsWith('/data/'));
assert.equal(fs.realpathSync(path.dirname(file)),path.dirname(file));
const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);assert(stat.isFile()&&stat.size<=${maximumReadBytes});
const bytes=fs.readFileSync(fd);assert(bytes.length<=${maximumReadBytes});console.log(JSON.stringify({base64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));}finally{fs.closeSync(fd);}`;
    const result = await execute('docker', ['exec', '-e', 'NODE_OPTIONS=', container, 'node', '-e', program,
      JSON.stringify({ relativePath: input.relativePath })], { timeout: 10_000, maxBuffer: 12 * 1024 * 1024 });
    const value = JSON.parse(result.stdout);
    assert(typeof value.base64 === 'string'); bytes = Buffer.from(value.base64, 'base64');
    assert.equal(bytes.toString('base64'), value.base64); assert(bytes.length <= maximumReadBytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), value.sha256);
  } else {
    const root = await realpath(input.dataRoot), file = path.join(root, input.relativePath);
    assert.equal(await realpath(path.dirname(file)), path.dirname(file));
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); assert(stat.isFile() && stat.size <= maximumReadBytes);
      bytes = await handle.readFile(); assert(bytes.length <= maximumReadBytes);
    } finally { await handle.close(); }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Write within the real watcher OS. Docker bind mounts do not promise host
 * filesystem notifications; the managed Linux target must own this exact DATA.
 */
export async function createOwnedFilesystemFixture(input: {
  dataRoot: string; relativePath: string; seedRelativePath: string; seedContent: string; content: string;
}): Promise<void> {
  for (const relative of [input.relativePath, input.seedRelativePath]) relativeFixturePath(relative);
  const container = await ownedFilesystemContainer(input.dataRoot);
  if (!container) {
    await writeFile(path.join(input.dataRoot, input.relativePath), input.content, { flag: 'wx' });
    return;
  }
  const program = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const value=JSON.parse(process.argv[1]),root='/data',file=path.resolve(root,value.relativePath),seed=path.resolve(root,value.seedRelativePath);
assert(file.startsWith(root+'/')&&seed.startsWith(root+'/'));assert.equal(path.dirname(file),path.dirname(seed));
assert.equal(fs.realpathSync(path.dirname(file)),path.dirname(file));assert.equal(fs.readFileSync(seed,'utf8'),value.seedContent);
fs.writeFileSync(file,value.content,{flag:'wx'});console.log(JSON.stringify({path:value.relativePath,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));`;
  const result = await execute('docker', ['exec', '-e', 'NODE_OPTIONS=', container, 'node', '-e', program, JSON.stringify(input)],
    { timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.deepEqual(JSON.parse(result.stdout), { path: input.relativePath,
    sha256: createHash('sha256').update(input.content).digest('hex') });
}
