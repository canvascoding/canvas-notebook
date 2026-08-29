import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { updatePortableCli } from '../cli/src/core/selfUpdate';
import type { CommandResult, CommandRunner, RunOptions, RuntimeContext } from '../cli/src/core/types';

class LinuxInstallerRunner implements CommandRunner {
  calls = 0;

  constructor(
    private readonly linuxRoot: string,
    private readonly nextVersion: string,
  ) {}

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.calls += 1;
    assert.equal(command, 'bash');
    assert.deepEqual(args, [path.join(this.linuxRoot, 'install', 'linux-cli.sh'), 'install']);
    assert.equal(options.stdio, 'inherit');
    assert.equal(options.env?.CANVAS_LINUX_CLI_ROOT, this.linuxRoot);
    assert.equal(options.env?.CANVAS_LINUX_CLI_BIN_PATH, path.join(this.linuxRoot, 'entrypoint'));
    assert.equal(options.env?.CANVAS_CLI_SELF_UPDATE_REEXEC, 'true');
    assert.match(String(options.env?.CANVAS_LINUX_CLI_ARCHIVE), /canvas-notebook-linux-cli-arm64\.tar\.gz$/u);
    assert.match(String(options.env?.CANVAS_LINUX_CLI_CHECKSUM), /canvas-notebook-linux-cli-arm64\.sha256$/u);

    const current = (await readFile(path.join(this.linuxRoot, 'state', 'current'), 'utf8')).trim();
    await mkdir(path.join(this.linuxRoot, 'releases', this.nextVersion, 'dist-cli'), { recursive: true });
    await writeFile(path.join(this.linuxRoot, 'releases', this.nextVersion, 'VERSION'), `${this.nextVersion}\n`, 'utf8');
    await writeFile(path.join(this.linuxRoot, 'releases', this.nextVersion, 'dist-cli', 'main.js'), 'console.log("next");\n', 'utf8');
    await writeFile(path.join(this.linuxRoot, 'state', 'previous'), `${current}\n`, 'utf8');
    await writeFile(path.join(this.linuxRoot, 'state', 'current'), `${this.nextVersion}\n`, 'utf8');
    return { status: 0, stdout: '', stderr: '' };
  }
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-linux-self-update-test-'));
  try {
    const linuxRoot = path.join(root, 'cli');
    const oldVersion = '2026.8.27.1';
    const nextVersion = '2026.8.28.1';
    const oldRoot = path.join(linuxRoot, 'releases', oldVersion);
    const assets = path.join(root, 'assets');
    const archiveName = 'canvas-notebook-linux-cli-arm64.tar.gz';
    const checksumName = 'canvas-notebook-linux-cli-arm64.sha256';
    await mkdir(path.join(oldRoot, 'dist-cli'), { recursive: true });
    await mkdir(path.join(linuxRoot, 'state'), { recursive: true });
    await mkdir(path.join(linuxRoot, 'install'), { recursive: true });
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(oldRoot, 'VERSION'), `${oldVersion}\n`, 'utf8');
    await writeFile(path.join(oldRoot, 'dist-cli', 'main.js'), 'console.log("old");\n', 'utf8');
    await writeFile(path.join(linuxRoot, 'state', 'current'), `${oldVersion}\n`, 'utf8');
    await writeFile(path.join(linuxRoot, 'state', 'previous'), '', 'utf8');
    await writeFile(path.join(linuxRoot, 'install', 'linux-cli.sh'), '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o755 });
    const archive = path.join(assets, archiveName);
    const checksum = path.join(assets, checksumName);
    await writeFile(archive, 'verified-linux-archive', 'utf8');
    const digest = crypto.createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(checksum, `${digest}  ${archiveName}\n`, 'utf8');

    const context: RuntimeContext = {
      platform: 'linux',
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
      CANVAS_CLI_ROOT: oldRoot,
      CANVAS_CLI_LINUX_ROOT: linuxRoot,
      CANVAS_LINUX_CLI_BIN_PATH: path.join(linuxRoot, 'entrypoint'),
      CANVAS_LINUX_CLI_ARCH: 'arm64',
      CANVAS_LINUX_CLI_URL: pathToFileURL(archive).toString(),
      CANVAS_LINUX_CLI_SHA256_URL: pathToFileURL(checksum).toString(),
    };
    const runner = new LinuxInstallerRunner(linuxRoot, nextVersion);
    const result = await updatePortableCli({ runner, context, env, argvMain: path.join(oldRoot, 'dist-cli', 'main.js') });
    assert.deepEqual(result, {
      skipped: false,
      changed: true,
      currentRoot: path.join(linuxRoot, 'releases', nextVersion),
      mainPath: path.join(linuxRoot, 'releases', nextVersion, 'dist-cli', 'main.js'),
      beforeVersion: oldVersion,
      afterVersion: nextVersion,
    });
    assert.equal(runner.calls, 1);

    await assert.rejects(
      updatePortableCli({
        runner,
        context,
        env: { ...env, CANVAS_CLI_ROOT: oldRoot },
        argvMain: path.join(oldRoot, 'dist-cli', 'main.js'),
      }),
      /does not match its current activation state/u,
    );
    assert.equal(runner.calls, 1);

    const badChecksum = path.join(assets, 'bad.sha256');
    await writeFile(badChecksum, `${'0'.repeat(64)}  ${archiveName}\n`, 'utf8');
    await assert.rejects(
      updatePortableCli({
        runner,
        context,
        env: {
          ...env,
          CANVAS_CLI_ROOT: path.join(linuxRoot, 'releases', nextVersion),
          CANVAS_LINUX_CLI_SHA256_URL: pathToFileURL(badChecksum).toString(),
        },
        argvMain: path.join(linuxRoot, 'releases', nextVersion, 'dist-cli', 'main.js'),
      }),
      /checksum verification failed/u,
    );
    assert.equal(runner.calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log('linux CLI self-update tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
