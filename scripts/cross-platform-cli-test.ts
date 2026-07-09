import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  composeEnvText,
  configureRuntimeAndDatabase,
  createDefaultConfig,
  materializeConfig,
  materializePostgresInfrastructureConfig,
  redactConfig,
} from '../cli/src/core/config';
import { renderComposeFile } from '../cli/src/core/compose';
import { DockerManager } from '../cli/src/core/docker';
import { composePath, resolveDefaultPaths } from '../cli/src/core/platform';
import { preparePostgresManagedRuntime, postgresRuntimeDesired } from '../cli/src/core/postgres';
import { renderMacosLaunchAgent, windowsTaskCommand } from '../cli/src/core/service';
import type { CommandRunner, RunOptions, RuntimeContext } from '../cli/src/core/types';

class RecordingRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; stdinConfigured: boolean }> = [];

  async run(command: string, args: string[], options: RunOptions = {}) {
    this.calls.push({ command, args, stdinConfigured: options.stdin !== undefined });
    const joined = args.join(' ');
    if (joined.includes('compose') && joined.includes('ps -q postgres')) {
      return { status: 0, stdout: 'pg-container\n', stderr: '' };
    }
    if (args[0] === 'inspect' && joined.includes('{{.State.Status}}')) {
      return { status: 0, stdout: 'running\n', stderr: '' };
    }
    if (args[0] === 'inspect' && joined.includes('{{.Id}}')) {
      return { status: 0, stdout: 'pg-container\n', stderr: '' };
    }
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

    const postgresConfig = materializeConfig(configureRuntimeAndDatabase(config, { database: 'postgres' }));
    assert.equal(postgresConfig.env.CANVAS_DATABASE_PROVIDER, 'postgres');
    assert.equal(postgresConfig.env.CANVAS_POSTGRES_VECTOR_ENABLED, true);
    assert.match(String(postgresConfig.env.DATABASE_URL), /^postgresql:\/\/canvas:/);
    assert.match(composeEnvText(postgresConfig, composePath(postgresConfig.dataDir, 'linux')), /^COMPOSE_PROFILES=postgres$/m);

    const teamConfig = materializeConfig(configureRuntimeAndDatabase(config, { runtime: 'team' }));
    assert.equal(teamConfig.env.CANVAS_DEPLOYMENT_MODE, 'managed-team');
    assert.equal(teamConfig.env.CANVAS_DATABASE_PROVIDER, 'postgres');
    assert.equal(teamConfig.env.CANVAS_POSTGRES_REQUIRED, true);

    assert.throws(
      () => configureRuntimeAndDatabase(config, { runtime: 'team', database: 'sqlite' }),
      /Team runtime requires --database postgres/u,
    );

    const inconsistentTeamSqlite = structuredClone(config);
    inconsistentTeamSqlite.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
    inconsistentTeamSqlite.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
    assert.throws(
      () => materializeConfig(inconsistentTeamSqlite),
      /requires CANVAS_DATABASE_PROVIDER=postgres/u,
    );

    const preparedPostgres = materializePostgresInfrastructureConfig(config);
    assert.equal(preparedPostgres.env.CANVAS_DATABASE_PROVIDER, 'sqlite');
    assert.equal(preparedPostgres.env.CANVAS_POSTGRES_REQUIRED, true);
    assert.match(String(preparedPostgres.env.DATABASE_URL), /^postgresql:\/\/canvas:/);
    assert.match(composeEnvText(preparedPostgres, composePath(preparedPostgres.dataDir, 'linux')), /^COMPOSE_PROFILES=$/m);
    assert.match(composeEnvText(preparedPostgres, composePath(preparedPostgres.dataDir, 'linux')), /^CANVAS_POSTGRES_PASSWORD=/m);

    const redactedPostgres = redactConfig(postgresConfig);
    assert.equal(redactedPostgres.env.DATABASE_URL, 'postgresql://***');
    assert.match(String(redactedPostgres.env.CANVAS_POSTGRES_PASSWORD), /^\w{4}\*\*\*$/u);

    assert.equal(postgresRuntimeDesired(config), false);
    assert.equal(postgresRuntimeDesired(postgresConfig), true);

    await preparePostgresManagedRuntime({ docker, config: postgresConfig });
    assert.ok(runner.calls.some((call) => call.args.join(' ').includes('--profile postgres up -d postgres')));
    assert.ok(runner.calls.some((call) => call.args.join(' ').includes('exec -i -u postgres pg-container psql')));
    assert.ok(runner.calls.some((call) => call.args.join(' ').includes('exec -i pg-container sh -c')));
    assert.ok(runner.calls.some((call) => call.stdinConfigured));
    const serializedArgs = JSON.stringify(runner.calls.map((call) => call.args));
    assert.equal(serializedArgs.includes(String(postgresConfig.env.CANVAS_POSTGRES_PASSWORD)), false);
    assert.equal(serializedArgs.includes(String(postgresConfig.env.DATABASE_URL)), false);
  });

  console.log('cross-platform CLI tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
