import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { composeEnvText, createDefaultConfig, materializeConfig } from '../cli/src/core/config';
import { renderComposeFile } from '../cli/src/core/compose';
import { DockerManager } from '../cli/src/core/docker';
import { composePath, resolveDefaultPaths } from '../cli/src/core/platform';
import { renderMacosLaunchAgent, windowsTaskCommand } from '../cli/src/core/service';
import type { CommandRunner, RuntimeContext } from '../cli/src/core/types';

class RecordingRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]) {
    this.calls.push({ command, args });
    return { status: 0, stdout: '', stderr: '' };
  }
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-cli-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  await withTempRoot(async (root) => {
    const macHome = path.join(root, 'mac-home');
    const macPaths = resolveDefaultPaths('macos', { ...process.env, HOME: macHome });
    assert.equal(macPaths.installDir, path.join(macHome, 'Library', 'Application Support', 'Canvas Notebook', 'manager'));
    assert.equal(macPaths.dataDir, path.join(macHome, 'Library', 'Application Support', 'Canvas Notebook', 'data'));
    assert.equal(macPaths.logFile, path.join(macHome, 'Library', 'Logs', 'Canvas Notebook', 'manager.log'));

    const macConfig = materializeConfig(createDefaultConfig(macPaths, 'macos'));
    assert.equal(macConfig.platform.serviceMode, 'launchd');
    assert.match(String(macConfig.env.BETTER_AUTH_SECRET), /^[A-Za-z0-9+/]+=*$/);
    assert.equal(macConfig.env.BASE_URL, 'http://localhost:3456');

    const macCompose = renderComposeFile(macConfig, 'macos');
    assert.match(macCompose, /env_file:/);
    assert.match(macCompose, /Library\/Application Support\/Canvas Notebook\/manager\/canvas-notebook\.env/);
    assert.match(macCompose, /\$\{DATA_DIR:-\.\/data\}:\/data/);
    assert.doesNotMatch(macCompose, /\/opt\/canvas-notebook/);

    const macPlist = renderMacosLaunchAgent(macConfig, '/usr/local/bin/canvas-notebook');
    assert.match(macPlist, /io\.canvasstudios\.notebook/);
    assert.match(macPlist, /<string>\/usr\/local\/bin\/canvas-notebook<\/string>/);
    assert.match(macPlist, /<string>start<\/string>/);
  });

  await withTempRoot(async (root) => {
    const localAppData = path.join(root, 'Local App Data');
    const winPaths = resolveDefaultPaths('windows', { ...process.env, LOCALAPPDATA: localAppData, USERPROFILE: path.join(root, 'user') });
    assert.equal(winPaths.installDir, path.join(localAppData, 'Canvas Notebook', 'manager'));
    assert.equal(winPaths.dataDir, path.join(localAppData, 'Canvas Notebook', 'data'));
    assert.equal(winPaths.logFile, path.join(localAppData, 'Canvas Notebook', 'logs', 'manager.log'));

    const winConfig = materializeConfig(createDefaultConfig(winPaths, 'windows'));
    assert.equal(winConfig.platform.serviceMode, 'scheduled-task');
    const composeDataDir = composePath('C:\\Users\\Test User\\Canvas Notebook\\data', 'windows');
    assert.equal(composeDataDir, 'C:/Users/Test User/Canvas Notebook/data');
    assert.match(composeEnvText(winConfig, composeDataDir), /DATA_DIR=C:\/Users\/Test User\/Canvas Notebook\/data/);
    assert.equal(windowsTaskCommand('C:\\Program Files\\Canvas Notebook\\canvas-notebook.exe'), '"C:\\Program Files\\Canvas Notebook\\canvas-notebook.exe" start --no-banner');
  });

  await withTempRoot(async (root) => {
    const paths = resolveDefaultPaths('linux', {
      ...process.env,
      HOME: path.join(root, 'home'),
      CANVAS_INSTALL_DIR: path.join(root, 'install'),
      CANVAS_DATA_DIR: path.join(root, 'data'),
      CANVAS_MANAGER_LOG_FILE: path.join(root, 'logs', 'manager.log'),
    });
    const config = materializeConfig(createDefaultConfig(paths, 'linux'));
    const runner = new RecordingRunner();
    const context: RuntimeContext = {
      platform: 'linux',
      paths,
      serviceName: 'canvas-notebook',
      dockerBin: 'docker',
    };
    const docker = new DockerManager(runner, context);
    const args = docker.composeArgs(config, ['up', '-d', '--force-recreate']);
    assert.deepEqual(args.slice(0, 5), ['compose', '-f', paths.composeFile, '--project-directory', paths.installDir]);
    assert.deepEqual(args.slice(5), ['up', '-d', '--force-recreate']);
  });

  console.log('cross-platform CLI tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
