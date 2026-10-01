import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-reexec-lifecycle-'));
  try {
    const worker = path.join(root, 'worker.mts');
    const core = path.resolve('cli/src/core');
    await writeFile(worker, `import { reexecPortableCliIfUpdated } from ${JSON.stringify(pathToFileURL(path.join(core, 'selfUpdate.ts')).href)};\nimport { SpawnCommandRunner } from ${JSON.stringify(pathToFileURL(path.join(core, 'process.ts')).href)};\nawait reexecPortableCliIfUpdated({runner:new SpawnCommandRunner(),context:{platform:'macos',paths:{installDir:process.env.CANVAS_CLI_ROOT}},command:'update',args:[],json:true,noBanner:true});\n`);
    for (const interrupted of process.platform === 'win32' ? [false] : [false, true]) {
      const directory = path.join(root, interrupted ? 'signal' : 'success');
      const current = path.join(directory, 'current');
      const bundle = path.join(directory, 'bundle');
      const next = path.join(bundle, 'canvas-notebook-cli');
      for (const [location, version, code] of [[current, '2026.10.1.2', 'console.log("old")'], [next, '2026.10.2.1', interrupted ? 'process.kill(process.pid,"SIGTERM")' : 'console.log(JSON.stringify({success:true}))']]) {
        await mkdir(path.join(location, 'dist-cli'), { recursive: true });
        await writeFile(path.join(location, 'dist-cli/main.js'), code);
        await writeFile(path.join(location, 'VERSION'), version);
        await writeFile(path.join(location, 'README.txt'), 'isolated fixture');
      }
      const archive = path.join(directory, 'canvas-notebook-cli.tar.gz');
      const checksum = path.join(directory, 'canvas-notebook-cli.sha256');
      await execute('tar', ['-czf', archive, '-C', bundle, 'canvas-notebook-cli']);
      await writeFile(checksum, createHash('sha256').update(await readFile(archive)).digest('hex'));
      const options = { timeout: 10000, env: { ...process.env, CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_CONTROL_PLANE_URL: '', CANVAS_CLI_SELF_UPDATE_REEXEC: 'false', CANVAS_CLI_SELF_UPDATE: 'true', CANVAS_CLI_SELF_UPDATE_ALLOW_LOCAL: 'true', CANVAS_CLI_ROOT: current, CANVAS_CLI_LINUX_ROOT: '', CANVAS_CLI_URL: pathToFileURL(archive).href, CANVAS_CLI_SHA256_URL: pathToFileURL(checksum).href } };
      const args = [path.resolve('node_modules/tsx/dist/cli.mjs'), worker];
      if (interrupted) {
        await assert.rejects(execute(process.execPath, args, options), (error: unknown) => {
          const result = error as { code: number; stdout: string };
          assert.notEqual(result.code, 0);
          assert.equal(result.stdout, '');
          return true;
        });
      } else {
        const result = await execute(process.execPath, args, options);
        assert.deepEqual(JSON.parse(result.stdout), { success: true });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  console.log('CLI reexec: interrupted updates fail and successful JSON remains parseable');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
