import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { portableCliReexecArgs, updatePortableCli } from '../cli/src/core/selfUpdate';
import { SpawnCommandRunner } from '../cli/src/core/process';
import type { RuntimeContext } from '../cli/src/core/types';

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function writeBundleRoot(root: string, version: string, marker: string): Promise<void> {
  await mkdir(path.join(root, 'dist-cli'), { recursive: true });
  await mkdir(path.join(root, 'install'), { recursive: true });
  await writeFile(path.join(root, 'dist-cli', 'main.js'), `console.log(${JSON.stringify(marker)});\n`, 'utf8');
  await writeFile(path.join(root, 'install', 'macos.sh'), 'echo macos\n', 'utf8');
  await writeFile(path.join(root, 'install', 'windows.ps1'), 'Write-Host windows\n', 'utf8');
  await writeFile(path.join(root, 'README.txt'), 'Canvas Notebook portable server CLI\n', 'utf8');
  await writeFile(path.join(root, 'VERSION'), `${version}\n`, 'utf8');
}

async function createArchive(sourceParent: string, outputDir: string): Promise<{ archive: string; checksum: string }> {
  const archive = path.join(outputDir, 'canvas-notebook-cli.tar.gz');
  const checksum = path.join(outputDir, 'canvas-notebook-cli.sha256');
  await run('tar', ['-czf', archive, '-C', sourceParent, 'canvas-notebook-cli'], outputDir);
  const digest = crypto.createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(checksum, `${digest}  canvas-notebook-cli.tar.gz\n`, 'utf8');
  return { archive, checksum };
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-portable-update-test-'));
  try {
    const currentRoot = path.join(root, 'installed', 'canvas-notebook-cli');
    const bundleParent = path.join(root, 'bundle');
    const nextRoot = path.join(bundleParent, 'canvas-notebook-cli');
    const assetsDir = path.join(root, 'assets');
    await writeBundleRoot(currentRoot, '2026.7.8.1', 'old-cli');
    await writeBundleRoot(nextRoot, '2026.7.9.3', 'new-cli');
    await mkdir(assetsDir, { recursive: true });
    const { archive, checksum } = await createArchive(bundleParent, assetsDir);

    const context: RuntimeContext = {
      platform: 'macos',
      paths: {
        installDir: path.join(root, 'manager'),
        dataDir: path.join(root, 'data'),
        configFile: path.join(root, 'manager', 'config.json'),
        composeFile: path.join(root, 'manager', 'compose.yaml'),
        containerEnvFile: path.join(root, 'manager', 'canvas.env'),
        composeEnvFile: path.join(root, 'manager', '.env'),
        logFile: path.join(root, 'logs', 'manager.log'),
      },
      serviceName: 'canvas-notebook',
      dockerBin: 'docker',
    };
    const env = {
      ...process.env,
      CANVAS_CLI_ROOT: currentRoot,
      CANVAS_CLI_SELF_UPDATE_ALLOW_LOCAL: 'true',
      CANVAS_CLI_URL: pathToFileURL(archive).toString(),
      CANVAS_CLI_SHA256_URL: pathToFileURL(checksum).toString(),
    };
    const result = await updatePortableCli({
      runner: new SpawnCommandRunner(),
      context,
      env,
      argvMain: path.join(currentRoot, 'dist-cli', 'main.js'),
    });

    assert.equal(result.skipped, false);
    assert.equal(result.changed, true);
    assert.equal(result.beforeVersion, '2026.7.8.1');
    assert.equal(result.afterVersion, '2026.7.9.3');
    assert.match(await readFile(path.join(currentRoot, 'dist-cli', 'main.js'), 'utf8'), /new-cli/u);

    const second = await updatePortableCli({
      runner: new SpawnCommandRunner(),
      context,
      env,
      argvMain: path.join(currentRoot, 'dist-cli', 'main.js'),
    });
    assert.equal(second.changed, false);

    assert.deepEqual(
      portableCliReexecArgs({ command: 'update', args: ['--foo'], json: false, noBanner: true }),
      ['update', '--no-banner', '--foo'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log('portable CLI self-update tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
