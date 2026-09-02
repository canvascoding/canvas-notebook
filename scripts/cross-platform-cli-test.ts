import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';

import {
  configSecretState,
  composeEnvText,
  configureRuntimeAndDatabase,
  createDefaultConfig,
  isPinnedImageReference,
  materializeConfig,
  materializePostgresInfrastructureConfig,
  normalizeConfig,
  redactConfig,
  writeConfig,
  writeEnvFiles,
  writeSecureFile,
} from '../cli/src/core/config';
import { renderComposeFile } from '../cli/src/core/compose';
import { monotonicDeadlineMs, remainingMonotonicSeconds } from '../cli/src/core/deadline';
import { DockerManager } from '../cli/src/core/docker';
import { orphanedComposeLogFollowerPids } from '../cli/src/core/logCleanup';
import { composePath, resolveDefaultPaths } from '../cli/src/core/platform';
import { preparePostgresManagedRuntime, postgresRuntimeDesired } from '../cli/src/core/postgres';
import {
  createPostgresRecoverySnapshot,
  writePostgresRecoveryJournal,
} from '../cli/src/core/postgresRecovery';
import { MAX_CAPTURED_PROCESS_OUTPUT_BYTES, SpawnCommandRunner } from '../cli/src/core/process';
import { renderMacosLaunchAgent, windowsTaskCommand } from '../cli/src/core/service';
import { update } from '../cli/src/main';
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

class UpdateRunner implements CommandRunner {
  calls: Array<{ args: string[]; stdinConfigured: boolean; timeoutMs?: number }> = [];
  runningImageId = 'old-image-id';
  mutableImageId = 'old-image-id';
  rolePassword = 'old-role-password';
  desiredRolePassword = '';
  postgresInitialized = true;
  failPull = false;
  healthMode: 'healthy' | 'new-unhealthy' = 'healthy';

  constructor(
    private readonly composeEnvFile: string,
    private readonly mutableImage: string,
    private readonly targetImage: string,
  ) {}

  async run(_command: string, args: string[], options: RunOptions = {}) {
    this.calls.push({ args: [...args], stdinConfigured: options.stdin !== undefined, timeoutMs: options.timeoutMs });
    const joined = args.join(' ');
    if (args[0] === 'compose') {
      if (joined.includes('ps -q postgres')) {
        return this.postgresInitialized
          ? { status: 0, stdout: 'pg-container\n', stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (joined.includes('up -d --no-recreate postgres')) {
        const composeEnv = await readFile(this.composeEnvFile, 'utf8');
        this.rolePassword = composeEnv.split(/\r?\n/u)
          .find((line) => line.startsWith('CANVAS_POSTGRES_PASSWORD='))
          ?.slice('CANVAS_POSTGRES_PASSWORD='.length) || '';
        this.postgresInitialized = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (joined.includes('ps -q canvas-notebook')) return { status: 0, stdout: 'app-container\n', stderr: '' };
      if (joined.includes(' pull canvas-notebook')) {
        return this.failPull
          ? { status: 55, stdout: '', stderr: 'pull failed' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (joined.includes('up -d --force-recreate --no-deps canvas-notebook')) {
        const composeEnv = await readFile(this.composeEnvFile, 'utf8');
        const image = options.env?.CANVAS_IMAGE
          || composeEnv.split(/\r?\n/u).find((line) => line.startsWith('CANVAS_IMAGE='))?.slice('CANVAS_IMAGE='.length)
          || '';
        if (image === this.targetImage) this.runningImageId = 'new-image-id';
        else if (image === this.mutableImage) this.runningImageId = this.mutableImageId;
        else throw new Error(`Unexpected compose image: ${image}`);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'inspect') {
      if (joined.includes('{{.Image}}')) return { status: 0, stdout: `${this.runningImageId}\n`, stderr: '' };
      if (joined.includes('{{.State.Running}}')) return { status: 0, stdout: 'true\n', stderr: '' };
      if (joined.includes('{{.State.Status}}')) return { status: 0, stdout: 'running\n', stderr: '' };
      if (joined.includes('{{.State.StartedAt}}')) return { status: 0, stdout: '2026-07-11T00:00:00Z\n', stderr: '' };
      if (joined.includes('{{.Id}}')) {
        return this.postgresInitialized
          ? { status: 0, stdout: 'pg-container\n', stderr: '' }
          : { status: 1, stdout: '', stderr: 'not found' };
      }
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return this.postgresInitialized
        ? { status: 0, stdout: '[]\n', stderr: '' }
        : { status: 1, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const image = args[2];
      if (image === this.targetImage) return { status: 0, stdout: 'new-image-id\n', stderr: '' };
      if (image === this.mutableImage) return { status: 0, stdout: `${this.mutableImageId}\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'tag') {
      if (args[3] !== this.mutableImage) return { status: 1, stdout: '', stderr: 'invalid tag target' };
      this.mutableImageId = args[2];
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'exec') {
      if (args.includes('pg_isready')) return { status: 0, stdout: '', stderr: '' };
      if (args.includes('psql') && args.includes('-u')) {
        const sql = String(options.stdin || '');
        const sqlLiterals = [...sql.matchAll(/'((?:''|[^'])*)'/gu)];
        const passwordLiteral = sqlLiterals.at(-1)?.[1];
        this.rolePassword = passwordLiteral
          ? passwordLiteral.replace(/''/gu, "'")
          : this.desiredRolePassword;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args.includes('sh') && args.includes('-c')) {
        const supplied = String(options.stdin || '').split(/\r?\n/u)[2] || '';
        return supplied === this.rolePassword
          ? { status: 0, stdout: '1\n', stderr: '' }
          : { status: 28, stdout: '', stderr: 'password authentication failed' };
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const output: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(' '));
  try {
    await fn();
    return output;
  } finally {
    console.log = original;
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
  let monotonicNow = 5_000;
  const monotonicClock = () => monotonicNow;
  const relativeDeadline = monotonicDeadlineMs(10, monotonicClock);
  const originalDateNow = Date.now;
  try {
    Date.now = () => originalDateNow() + 30 * 60 * 1000;
    assert.equal(remainingMonotonicSeconds(relativeDeadline, monotonicClock), 10);
    monotonicNow += 1_001;
    assert.equal(remainingMonotonicSeconds(relativeDeadline, monotonicClock), 9);
    monotonicNow += 9_000;
    assert.equal(remainingMonotonicSeconds(relativeDeadline, monotonicClock), 0);
  } finally {
    Date.now = originalDateNow;
  }

  const processRunner = new SpawnCommandRunner();
  const oversizedOutput = await processRunner.run(process.execPath, [
    '-e',
    `const size = Number(process.argv[1]);
process.stdout.write('SENSITIVE_STDOUT_PREFIX_MUST_BE_DISCARDED\\n');
process.stdout.write('o'.repeat(size));
process.stdout.write('\\nSTDOUT_TAIL_SENTINEL\\n');
process.stderr.write('SENSITIVE_STDERR_PREFIX_MUST_BE_DISCARDED\\n');
process.stderr.write('e'.repeat(size));
process.stderr.write('\\nSTDERR_TAIL_SENTINEL\\n');`,
    String(MAX_CAPTURED_PROCESS_OUTPUT_BYTES),
  ]);
  assert.equal(oversizedOutput.status, 0);
  assert.equal(Buffer.byteLength(oversizedOutput.stdout, 'utf8'), MAX_CAPTURED_PROCESS_OUTPUT_BYTES);
  assert.equal(Buffer.byteLength(oversizedOutput.stderr, 'utf8'), MAX_CAPTURED_PROCESS_OUTPUT_BYTES);
  assert.match(oversizedOutput.stdout, /^\[\.\.\. process output truncated; showing tail \.\.\.\]\n/u);
  assert.match(oversizedOutput.stderr, /^\[\.\.\. process output truncated; showing tail \.\.\.\]\n/u);
  assert.match(oversizedOutput.stdout, /STDOUT_TAIL_SENTINEL\n$/u);
  assert.match(oversizedOutput.stderr, /STDERR_TAIL_SENTINEL\n$/u);
  assert.doesNotMatch(oversizedOutput.stdout, /SENSITIVE_STDOUT_PREFIX/u);
  assert.doesNotMatch(oversizedOutput.stderr, /SENSITIVE_STDERR_PREFIX/u);

  const timedOutProcess = await processRunner.run(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000);',
  ], { timeoutMs: 50 });
  assert.equal(timedOutProcess.status, 124);
  assert.match(timedOutProcess.stderr, /Command exceeded its update deadline\.$/u);

  const digest = 'a'.repeat(64);
  assert.equal(isPinnedImageReference(`ghcr.io/canvas-studios/canvas-notebook@sha256:${digest}`), true);
  assert.equal(isPinnedImageReference(`ghcr.io/canvas-studios/canvas-notebook:latest@sha256:${digest}`), true);
  assert.equal(isPinnedImageReference(`registry.example.com:5000/team/canvas_notebook:release_1@sha256:${digest}`), true);
  assert.equal(isPinnedImageReference(`ghcr.io/canvas-studios/canvas-notebook:latest`), false);
  assert.equal(isPinnedImageReference(`ghcr.io/canvas-studios/canvas-notebook@sha256:${'a'.repeat(63)}`), false);
  assert.equal(isPinnedImageReference(`ghcr.io/canvas-studios/canvas-notebook@sha256:${digest};touch /tmp/pwned`), false);

  await withTempRoot(async (root) => {
    const macHome = path.join(root, 'mac-home');
    const macPaths = resolveDefaultPaths('macos', { ...process.env, HOME: macHome });
    assert.equal(macPaths.installDir, path.join(macHome, 'Library', 'Application Support', 'Canvas Notebook', 'manager'));
    assert.equal(macPaths.dataDir, path.join(macHome, 'Library', 'Application Support', 'Canvas Notebook', 'data'));
    assert.equal(macPaths.logFile, path.join(macHome, 'Library', 'Logs', 'Canvas Notebook', 'manager.log'));

    const macConfig = materializeConfig(createDefaultConfig(macPaths, 'macos'));
    assert.equal(macConfig.platform.serviceMode, 'launchd');
    assert.equal(macConfig.autoUpdate.enabled, false);
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
    assert.equal(windowsTaskCommand('C:\\Canvas\\'), '"C:\\Canvas\\\\" start --no-banner');
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
    assert.deepEqual(orphanedComposeLogFollowerPids([
      `101 1 docker compose -f ${paths.composeFile} --project-directory ${paths.installDir} logs -f --tail=120 canvas-notebook`,
      `102 99 docker compose -f ${paths.composeFile} --project-directory ${paths.installDir} logs -f canvas-notebook`,
      `103 1 docker compose -f /other/compose.yaml --project-directory ${paths.installDir} logs -f canvas-notebook`,
      `104 1 docker compose -f ${paths.composeFile} --project-directory ${paths.installDir} ps canvas-notebook`,
      '',
    ].join('\n'), config, 'canvas-notebook'), [101]);
    const runner = new RecordingRunner();
    const context: RuntimeContext = {
      platform: 'linux',
      paths,
      serviceName: 'canvas-notebook',
      dockerBin: 'docker',
    };
    const docker = new DockerManager(runner, context);
    await writeConfig(config);
    await writeEnvFiles(config, composePath(config.dataDir, 'linux'));
    for (const filePath of [paths.configFile, paths.containerEnvFile, paths.composeEnvFile]) {
      assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    }
    assert.equal((await readdir(paths.installDir)).some((entry) => entry.endsWith('.tmp')), false);
    const args = docker.composeArgs(config, ['up', '-d', '--force-recreate']);
    assert.deepEqual(args.slice(0, 5), ['compose', '-f', paths.composeFile, '--project-directory', paths.installDir]);
    assert.deepEqual(args.slice(5), ['up', '-d', '--force-recreate']);
    const safeApplyArgs = docker.composeArgs(config, ['up', '-d', '--no-deps', 'canvas-notebook']);
    assert.deepEqual(safeApplyArgs.slice(5), ['up', '-d', '--no-deps', 'canvas-notebook']);

    const postgresConfig = materializeConfig(configureRuntimeAndDatabase(config, { database: 'postgres' }));
    assert.equal(postgresConfig.env.CANVAS_DATABASE_PROVIDER, 'postgres');
    assert.equal(postgresConfig.env.CANVAS_POSTGRES_MODE, 'managed');
    assert.equal(postgresConfig.env.CANVAS_POSTGRES_VECTOR_ENABLED, true);
    assert.match(String(postgresConfig.env.DATABASE_URL), /^postgresql:\/\/canvas:/);
    assert.match(composeEnvText(postgresConfig, composePath(postgresConfig.dataDir, 'linux')), /^COMPOSE_PROFILES=postgres$/m);
    assert.match(composeEnvText(postgresConfig, composePath(postgresConfig.dataDir, 'linux')), /^CANVAS_POSTGRES_MODE=managed$/m);
    const missingPostgresCredentials = configureRuntimeAndDatabase(config, { database: 'postgres' });
    assert.throws(
      () => materializeConfig(missingPostgresCredentials, undefined, { allowPostgresSecretGeneration: false }),
      /database prepare-postgres/u,
    );
    const encodedReservedPasswordConfig = structuredClone(missingPostgresCredentials);
    encodedReservedPasswordConfig.env.DATABASE_URL = 'postgresql://canvas:legacy%40password@postgres:5432/canvas_notebook';
    const materializedEncodedPassword = materializeConfig(encodedReservedPasswordConfig, undefined, { allowPostgresSecretGeneration: false });
    assert.equal(materializedEncodedPassword.env.CANVAS_POSTGRES_PASSWORD, 'legacy@password');
    assert.equal(materializedEncodedPassword.env.DATABASE_URL, 'postgresql://canvas:legacy%40password@postgres:5432/canvas_notebook');

    const teamConfig = materializeConfig(configureRuntimeAndDatabase(config, { runtime: 'team' }));
    assert.equal(teamConfig.env.CANVAS_DEPLOYMENT_MODE, 'managed-team');
    assert.equal(teamConfig.env.CANVAS_DATABASE_PROVIDER, 'postgres');
    assert.equal(teamConfig.env.CANVAS_POSTGRES_MODE, 'managed');
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
    assert.equal(preparedPostgres.env.CANVAS_POSTGRES_MODE, 'managed');
    assert.match(String(preparedPostgres.env.DATABASE_URL), /^postgresql:\/\/canvas:/);
    assert.match(composeEnvText(preparedPostgres, composePath(preparedPostgres.dataDir, 'linux')), /^COMPOSE_PROFILES=$/m);
    assert.match(composeEnvText(preparedPostgres, composePath(preparedPostgres.dataDir, 'linux')), /^CANVAS_POSTGRES_PASSWORD=/m);

    const redactedPostgres = redactConfig(postgresConfig);
    assert.equal(redactedPostgres.env.DATABASE_URL, 'postgresql://***');
    assert.match(String(redactedPostgres.env.CANVAS_POSTGRES_PASSWORD), /^\w{4}\*\*\*$/u);
    const secretState = configSecretState(postgresConfig);
    assert.equal(secretState.CANVAS_POSTGRES_PASSWORD.present, true);
    assert.match(secretState.CANVAS_POSTGRES_PASSWORD.fingerprint || '', /^[a-f0-9]{64}$/u);
    assert.equal(
      configSecretState(postgresConfig).CANVAS_POSTGRES_PASSWORD.fingerprint,
      secretState.CANVAS_POSTGRES_PASSWORD.fingerprint,
    );
    assert.deepEqual(configSecretState(config).CANVAS_POSTGRES_PASSWORD, { present: false, fingerprint: null });
    const dynamicSecretConfig = structuredClone(postgresConfig);
    dynamicSecretConfig.env.CANVAS_INSTANCE_TOKEN = 'dynamic-instance-token';
    dynamicSecretConfig.env.OPENAI_API_KEY = 'dynamic-openai-key';
    dynamicSecretConfig.env.CANVAS_LICENSE_CERT = 'dynamic-license-cert';
    dynamicSecretConfig.env.CUSTOM_SECRET_KEY = 'dynamic-secret-key';
    dynamicSecretConfig.env.openai_api_key = 'lowercase-openai-key';
    assert.equal(redactConfig(dynamicSecretConfig).env.CANVAS_INSTANCE_TOKEN, 'dyna***');
    assert.equal(redactConfig(dynamicSecretConfig).env.OPENAI_API_KEY, 'dyna***');
    assert.equal(redactConfig(dynamicSecretConfig).env.CANVAS_LICENSE_CERT, 'dyna***');
    assert.equal(redactConfig(dynamicSecretConfig).env.CUSTOM_SECRET_KEY, 'dyna***');
    assert.equal(redactConfig(dynamicSecretConfig).env.openai_api_key, 'lowe***');
    const dynamicSecretState = configSecretState(dynamicSecretConfig);
    assert.equal(dynamicSecretState.CANVAS_INSTANCE_TOKEN.present, true);
    assert.match(dynamicSecretState.CANVAS_INSTANCE_TOKEN.fingerprint || '', /^[a-f0-9]{64}$/u);
    assert.match(dynamicSecretState.OPENAI_API_KEY.fingerprint || '', /^[a-f0-9]{64}$/u);
    assert.match(dynamicSecretState.CANVAS_LICENSE_CERT.fingerprint || '', /^[a-f0-9]{64}$/u);
    assert.match(dynamicSecretState.CUSTOM_SECRET_KEY.fingerprint || '', /^[a-f0-9]{64}$/u);
    assert.match(dynamicSecretState.openai_api_key.fingerprint || '', /^[a-f0-9]{64}$/u);

    assert.equal(postgresRuntimeDesired(config), false);
    assert.equal(postgresRuntimeDesired(postgresConfig), true);
    const postgresRequiredConfig = structuredClone(config);
    postgresRequiredConfig.env.CANVAS_POSTGRES_REQUIRED = true;
    assert.equal(postgresRuntimeDesired(postgresRequiredConfig), true);
    const explicitSqliteWithLegacyUrl = structuredClone(config);
    explicitSqliteWithLegacyUrl.env.DATABASE_URL = 'postgresql://canvas:legacy-password@postgres:5432/canvas_notebook';
    assert.equal(postgresRuntimeDesired(explicitSqliteWithLegacyUrl), false);
    const legacyUrlOnly = normalizeConfig({
      env: {
        DATABASE_URL: 'postgresql://canvas:legacy-password@postgres:5432/canvas_notebook',
        CANVAS_POSTGRES_USER: 'canvas',
        CANVAS_POSTGRES_DB: 'canvas_notebook',
        CANVAS_POSTGRES_PASSWORD: 'legacy-password',
      },
    }, createDefaultConfig(paths, 'linux'));
    assert.equal(legacyUrlOnly.env.CANVAS_DATABASE_PROVIDER, '');
    assert.equal(postgresRuntimeDesired(legacyUrlOnly), true);
    assert.equal(materializeConfig(legacyUrlOnly, undefined, { allowPostgresSecretGeneration: false }).env.CANVAS_DATABASE_PROVIDER, 'postgres');
    assert.equal(materializeConfig(legacyUrlOnly, undefined, { allowPostgresSecretGeneration: false }).env.CANVAS_POSTGRES_MODE, 'managed');

    const externalPostgres = configureRuntimeAndDatabase(config, {
      database: 'postgres',
      postgresMode: 'external',
    });
    externalPostgres.env.DATABASE_URL = 'postgresql://external-user:external-password@db.example.test:5432/canvas';
    externalPostgres.env.CANVAS_POSTGRES_PASSWORD = 'must-not-be-duplicated';
    const materializedExternal = materializeConfig(externalPostgres, undefined, { allowPostgresSecretGeneration: false });
    assert.equal(materializedExternal.env.CANVAS_DATABASE_PROVIDER, 'postgres');
    assert.equal(materializedExternal.env.CANVAS_POSTGRES_MODE, 'external');
    assert.equal(materializedExternal.env.CANVAS_POSTGRES_PASSWORD, '');
    assert.match(composeEnvText(materializedExternal, composePath(materializedExternal.dataDir, 'linux')), /^COMPOSE_PROFILES=$/m);
    assert.match(composeEnvText(materializedExternal, composePath(materializedExternal.dataDir, 'linux')), /^CANVAS_POSTGRES_MODE=external$/m);
    const missingExternalUrl = configureRuntimeAndDatabase(config, {
      database: 'postgres',
      postgresMode: 'external',
    });
    assert.throws(
      () => materializeConfig(missingExternalUrl, undefined, { allowPostgresSecretGeneration: false }),
      /External Postgres requires DATABASE_URL/u,
    );

    const invalidProtocolConfig = structuredClone(postgresConfig);
    invalidProtocolConfig.env.DATABASE_URL = `http://canvas:${invalidProtocolConfig.env.CANVAS_POSTGRES_PASSWORD}@postgres:5432/canvas_notebook`;
    const callsBeforeInvalidProtocol = runner.calls.length;
    await assert.rejects(
      preparePostgresManagedRuntime({ docker, config: invalidProtocolConfig }),
      /must use postgres/u,
    );
    assert.equal(runner.calls.length, callsBeforeInvalidProtocol);

    await preparePostgresManagedRuntime({ docker, config: postgresConfig });
    assert.ok(runner.calls.some((call) => call.args.join(' ').includes('--profile postgres up -d --no-recreate postgres')));
    assert.equal(runner.calls.some((call) => call.args.join(' ').includes('exec -i -u postgres pg-container psql')), false);
    assert.ok(runner.calls.some((call) => call.args.join(' ').includes('exec -i pg-container sh -c')));
    assert.ok(runner.calls.some((call) => call.stdinConfigured));
    const serializedArgs = JSON.stringify(runner.calls.map((call) => call.args));
    assert.equal(serializedArgs.includes(String(postgresConfig.env.CANVAS_POSTGRES_PASSWORD)), false);
    assert.equal(serializedArgs.includes(String(postgresConfig.env.DATABASE_URL)), false);
  });

  await withTempRoot(async (root) => {
    const paths = resolveDefaultPaths('linux', {
      ...process.env,
      HOME: path.join(root, 'home'),
      CANVAS_INSTALL_DIR: path.join(root, 'install'),
      CANVAS_DATA_DIR: path.join(root, 'data'),
      CANVAS_MANAGER_LOG_FILE: path.join(root, 'logs', 'manager.log'),
    });
    const mutableImage = 'ghcr.io/canvascoding/canvas-notebook:latest';
    const targetImage = `ghcr.io/canvascoding/canvas-notebook:release_1@sha256:${'b'.repeat(64)}`;
    const context: RuntimeContext = {
      platform: 'linux',
      paths,
      serviceName: 'canvas-notebook',
      dockerBin: 'docker',
    };
    const runner = new UpdateRunner(paths.composeEnvFile, mutableImage, targetImage);
    const docker = new DockerManager(runner, context);
    const originalFetch = globalThis.fetch;
    const originalHealthAttempts = process.env.CANVAS_HEALTH_MAX_ATTEMPTS;
    globalThis.fetch = async () => new Response(null, {
      status: runner.healthMode === 'new-unhealthy' && runner.runningImageId === 'new-image-id' ? 503 : 200,
    });
    process.env.CANVAS_HEALTH_MAX_ATTEMPTS = '1';
    try {
      const reset = async () => {
        const config = materializeConfig(createDefaultConfig(paths, 'linux'));
        config.image = mutableImage;
        await writeConfig(config);
        await writeEnvFiles(config, composePath(config.dataDir, 'linux'));
        runner.calls = [];
        runner.runningImageId = 'old-image-id';
        runner.mutableImageId = 'old-image-id';
        runner.failPull = false;
        runner.healthMode = 'healthy';
        process.exitCode = undefined;
        return config;
      };

      let config = await reset();
      const originalDeadline = process.env.CANVAS_UPDATE_DEADLINE_EPOCH_MS;
      const originalReserve = process.env.CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS;
      process.env.CANVAS_UPDATE_DEADLINE_EPOCH_MS = String(Date.now() - 1000);
      process.env.CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS = '120';
      const expiredDeadline = await captureConsole(() => update(context, docker, config, true, { image: targetImage }));
      assert.equal(JSON.parse(expiredDeadline.at(-1) || '{}').phase, 'arguments');
      assert.equal(runner.calls.some((call) => call.args.includes('pull')), false);
      if (originalDeadline === undefined) delete process.env.CANVAS_UPDATE_DEADLINE_EPOCH_MS;
      else process.env.CANVAS_UPDATE_DEADLINE_EPOCH_MS = originalDeadline;
      if (originalReserve === undefined) delete process.env.CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS;
      else process.env.CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS = originalReserve;
      process.exitCode = undefined;
      const composeEnvBeforePull = await readFile(paths.composeEnvFile, 'utf8');
      runner.failPull = true;
      const pullFailure = await captureConsole(() => update(context, docker, config, true, { image: targetImage }));
      assert.equal(process.exitCode, 1);
      assert.deepEqual(JSON.parse(pullFailure.at(-1) || '{}'), {
        success: false,
        phase: 'pull',
        error: 'Update failed during pull; the running container was not changed.',
        rolledBack: false,
      });
      assert.equal((JSON.parse(await readFile(paths.configFile, 'utf8')) as { image: string }).image, mutableImage);
      assert.equal(await readFile(paths.composeEnvFile, 'utf8'), composeEnvBeforePull);
      assert.equal(runner.runningImageId, 'old-image-id');

      config = await reset();
      process.env.CANVAS_UPDATE_DEADLINE_EPOCH_MS = String(Date.now() + 32000);
      process.env.CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS = '30';
      const success = await captureConsole(() => update(context, docker, config, true, { image: targetImage }));
      assert.equal(process.exitCode, undefined);
      assert.equal(JSON.parse(success.at(-1) || '{}').success, true);
      assert.equal((JSON.parse(await readFile(paths.configFile, 'utf8')) as { image: string }).image, mutableImage);
      assert.match(await readFile(paths.composeEnvFile, 'utf8'), new RegExp(`^CANVAS_IMAGE=${mutableImage.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));
      assert.equal(runner.runningImageId, 'new-image-id');
      assert.equal(runner.mutableImageId, 'new-image-id');
      const boundedPull = runner.calls.find((call) => call.args.includes('pull'));
      assert.ok(boundedPull?.timeoutMs && boundedPull.timeoutMs > 0 && boundedPull.timeoutMs <= 2000);
      if (originalDeadline === undefined) delete process.env.CANVAS_UPDATE_DEADLINE_EPOCH_MS;
      else process.env.CANVAS_UPDATE_DEADLINE_EPOCH_MS = originalDeadline;
      if (originalReserve === undefined) delete process.env.CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS;
      else process.env.CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS = originalReserve;

      config = await reset();
      runner.healthMode = 'new-unhealthy';
      const unhealthy = await captureConsole(() => update(context, docker, config, true, { image: targetImage }));
      assert.equal(process.exitCode, 1);
      assert.equal(JSON.parse(unhealthy.at(-1) || '{}').phase, 'health');
      assert.equal(JSON.parse(unhealthy.at(-1) || '{}').rolledBack, true);
      assert.equal(runner.runningImageId, 'old-image-id');
      assert.equal(runner.mutableImageId, 'old-image-id');

      config = await reset();
      const freshPostgresConfig = materializePostgresInfrastructureConfig(config);
      await writeConfig(freshPostgresConfig);
      runner.postgresInitialized = false;
      runner.calls = [];
      const freshPostgres = await captureConsole(() => update(context, docker, freshPostgresConfig, true, { image: targetImage }));
      assert.equal(JSON.parse(freshPostgres.at(-1) || '{}').success, true);
      assert.equal(runner.calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'inspect'), true);
      assert.equal(runner.calls.some((call) => call.args.includes('psql') && call.args.includes('-u')), false);
      assert.match(await readFile(paths.composeEnvFile, 'utf8'), /^CANVAS_POSTGRES_PASSWORD=.+$/mu);
      assert.equal(await readFile(path.join(paths.installDir, '.postgres-auth-reconcile.json')).then(() => true, () => false), false);
      assert.equal(await readFile(path.join(paths.installDir, '.postgres-auth-reconcile-state')).then(() => true, () => false), false);

      config = await reset();
      const rollbackConfig = materializeConfig(configureRuntimeAndDatabase(config, { database: 'postgres' }));
      rollbackConfig.env.CANVAS_POSTGRES_PASSWORD = 'portable-old-password-123';
      rollbackConfig.env.DATABASE_URL = 'postgresql://canvas:portable-old-password-123@postgres:5432/canvas_notebook';
      await writeConfig(rollbackConfig);
      await writeEnvFiles(rollbackConfig, composePath(rollbackConfig.dataDir, 'linux'));
      const rollbackContainerEnv = await readFile(paths.containerEnvFile, 'utf8');
      const rollbackComposeEnv = await readFile(paths.composeEnvFile, 'utf8');
      const desiredPassword = 'portable-new-password-456';
      config = structuredClone(rollbackConfig);
      config.env.CANVAS_POSTGRES_PASSWORD = desiredPassword;
      config.env.DATABASE_URL = `postgresql://canvas:${desiredPassword}@postgres:5432/canvas_notebook`;
      await writeConfig(config);
      const originalUpdatePostgresTimeout = process.env.CANVAS_UPDATE_POSTGRES_TIMEOUT;
      process.env.CANVAS_UPDATE_POSTGRES_TIMEOUT = 'invalid';
      process.exitCode = undefined;
      const invalidTimeout = await captureConsole(() => update(context, docker, config, true, { image: targetImage }));
      assert.equal(JSON.parse(invalidTimeout.at(-1) || '{}').phase, 'postgres_auth');
      assert.equal(JSON.parse(invalidTimeout.at(-1) || '{}').rolledBack, false);
      if (originalUpdatePostgresTimeout === undefined) delete process.env.CANVAS_UPDATE_POSTGRES_TIMEOUT;
      else process.env.CANVAS_UPDATE_POSTGRES_TIMEOUT = originalUpdatePostgresTimeout;
      process.exitCode = undefined;
      await writeEnvFiles(config, composePath(config.dataDir, 'linux'));
      const targetContainerEnv = await readFile(paths.containerEnvFile, 'utf8');
      await writeSecureFile(paths.containerEnvFile, targetContainerEnv);
      await writeSecureFile(paths.composeEnvFile, rollbackComposeEnv);
      await createPostgresRecoverySnapshot(config, {
        rollbackConfig,
        containerEnv: rollbackContainerEnv,
        composeEnv: rollbackComposeEnv,
      });
      await writePostgresRecoveryJournal(config, rollbackConfig, 'forward', null);
      const journalText = await readFile(path.join(paths.installDir, '.postgres-auth-reconcile.json'), 'utf8');
      assert.equal(journalText.includes(desiredPassword), false);
      assert.equal((await stat(path.join(paths.installDir, '.postgres-auth-reconcile.json'))).mode & 0o777, 0o600);
      runner.desiredRolePassword = desiredPassword;
      runner.rolePassword = 'portable-old-password-123';
      runner.failPull = true;
      runner.calls = [];
      const recovered = await captureConsole(() => update(context, docker, config, true, { image: targetImage }));
      assert.equal(JSON.parse(recovered.at(-1) || '{}').phase, 'pull');
      assert.equal(runner.rolePassword, desiredPassword);
      const alterIndex = runner.calls.findIndex((call) => call.args.includes('psql') && call.args.includes('-u'));
      const pullIndex = runner.calls.findIndex((call) => call.args.includes('pull'));
      assert.ok(alterIndex >= 0 && pullIndex > alterIndex);
      assert.equal(JSON.stringify(runner.calls.map((call) => call.args)).includes(desiredPassword), false);
      assert.match(await readFile(paths.containerEnvFile, 'utf8'), new RegExp(`^DATABASE_URL=postgresql://canvas:${desiredPassword}@postgres:5432/canvas_notebook$`, 'mu'));
      assert.match(await readFile(paths.composeEnvFile, 'utf8'), new RegExp(`^CANVAS_IMAGE=${mutableImage.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));
      assert.equal(await readFile(path.join(paths.installDir, '.postgres-auth-reconcile.json')).then(() => true, () => false), false);

      config = structuredClone(rollbackConfig);
      config.env.CANVAS_POSTGRES_PASSWORD = 'portable-crash-target-789';
      config.env.DATABASE_URL = 'postgresql://canvas:portable-crash-target-789@postgres:5432/canvas_notebook';
      await writeConfig(config);
      await writeSecureFile(paths.containerEnvFile, targetContainerEnv);
      await writeSecureFile(paths.composeEnvFile, rollbackComposeEnv);
      await createPostgresRecoverySnapshot(config, {
        rollbackConfig,
        containerEnv: rollbackContainerEnv,
        composeEnv: rollbackComposeEnv,
      });
      await writePostgresRecoveryJournal(config, rollbackConfig, 'rollback', null);
      runner.rolePassword = 'portable-crash-target-789';
      runner.failPull = true;
      process.exitCode = undefined;
      const rollbackRecovered = await captureConsole(() => update(context, docker, config, true, { image: targetImage }));
      assert.equal(JSON.parse(rollbackRecovered.at(-1) || '{}').phase, 'pull');
      assert.equal(runner.rolePassword, 'portable-old-password-123');
      const recoveredConfig = JSON.parse(await readFile(paths.configFile, 'utf8')) as { env: Record<string, string> };
      assert.equal(recoveredConfig.env.CANVAS_POSTGRES_PASSWORD, 'portable-old-password-123');
      assert.equal(await readFile(path.join(paths.installDir, '.postgres-auth-reconcile.json')).then(() => true, () => false), false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHealthAttempts === undefined) delete process.env.CANVAS_HEALTH_MAX_ATTEMPTS;
      else process.env.CANVAS_HEALTH_MAX_ATTEMPTS = originalHealthAttempts;
      process.exitCode = undefined;
    }
  });

  console.log('cross-platform CLI tests passed');
}

main().catch((error) => {
  console.error('cross-platform CLI tests failed', error);
  process.exitCode = 1;
});
