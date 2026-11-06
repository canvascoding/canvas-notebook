import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Write within the real watcher OS. Docker bind mounts do not promise host
 * filesystem notifications; the managed Linux target must own this exact DATA.
 */
export async function createOwnedFilesystemFixture(input: {
  dataRoot: string; relativePath: string; seedRelativePath: string; seedContent: string; content: string;
}): Promise<void> {
  for (const relative of [input.relativePath, input.seedRelativePath]) assert(relative && !relative.startsWith('/')
    && !relative.includes('\\') && !/[\p{Cc}\p{Cf}]/u.test(relative)
    && !relative.split('/').some(part => ['', '.', '..'].includes(part)));
  const container = process.env.CANVAS_NATIVE_FILE_EVENT_CONTAINER;
  if (!container) {
    await writeFile(path.join(input.dataRoot, input.relativePath), input.content, { flag: 'wx' });
    return;
  }
  assert.equal(container, 'canvas-local-prod-notebook');
  assert.equal(process.env.BASE_URL, 'http://127.0.0.1:3100');
  const expectedImage = process.env.CANVAS_NATIVE_FILE_EVENT_IMAGE;
  assert.match(expectedImage ?? '', /^sha256:[a-f0-9]{64}$/u);
  const { stdout } = await execute('docker', ['inspect', container, '--format',
    '{"image":{{json .Image}},"running":{{json .State.Running}},"managed":{{json (index .Config.Labels "io.canvas.local-prod")}},"mounts":{{json .Mounts}}}'],
  { timeout: 10_000, maxBuffer: 64 * 1024 });
  const target = JSON.parse(stdout);
  assert.equal(target.image, expectedImage); assert.equal(target.running, true); assert.equal(target.managed, 'true');
  const mount = target.mounts.find((entry: { Destination: string }) => entry.Destination === '/data');
  assert.equal(mount?.Type, 'bind');
  assert.equal(await realpath(mount.Source), await realpath(input.dataRoot));
  const program = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const value=JSON.parse(process.argv[1]),root='/data',file=path.resolve(root,value.relativePath),seed=path.resolve(root,value.seedRelativePath);
assert(file.startsWith(root+'/')&&seed.startsWith(root+'/'));assert.equal(path.dirname(file),path.dirname(seed));
assert.equal(fs.realpathSync(path.dirname(file)),path.dirname(file));assert.equal(fs.readFileSync(seed,'utf8'),value.seedContent);
fs.writeFileSync(file,value.content,{flag:'wx'});console.log(JSON.stringify({path:value.relativePath,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));`;
  const result = await execute('docker', ['exec', container, 'node', '-e', program, JSON.stringify(input)],
    { timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.deepEqual(JSON.parse(result.stdout), { path: input.relativePath,
    sha256: createHash('sha256').update(input.content).digest('hex') });
}
