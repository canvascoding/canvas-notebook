import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

type ImplementationStatus = 'implemented' | 'partial' | 'missing';

interface CliParityContract {
  schemaVersion: number;
  legacyTopLevelCommands: string[];
  typescriptTopLevelCommands: string[];
  topLevelParity: Array<{
    command: string;
    legacy: ImplementationStatus;
    typescript: ImplementationStatus;
  }>;
  subcommandParity: Array<{
    feature: string;
    legacy: ImplementationStatus;
    typescript: ImplementationStatus;
  }>;
  configurationPaths: Array<{
    path: string;
    typescript: ImplementationStatus;
  }>;
  controlPlaneInvocations: Array<{
    command: string;
    currentlySupported: boolean;
  }>;
}

const root = process.cwd();
const contractPath = path.join(root, 'scripts', 'fixtures', 'cli-command-parity.json');
const legacyCliPath = path.join(root, 'install', 'bin', 'canvas-notebook');
const typescriptCliPath = path.join(root, 'cli', 'src', 'main.ts');
const execFileAsync = promisify(execFile);

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function extractLegacyTopLevelCommands(source: string): string[] {
  const start = source.indexOf('cmd_file_for() {');
  const end = source.indexOf('\n}\n\ncmd_file=', start);
  assert.notEqual(start, -1, 'Legacy CLI command dispatcher was not found.');
  assert.notEqual(end, -1, 'Legacy CLI command dispatcher end was not found.');
  const commands = source.slice(start, end)
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s{4}([a-z][a-z0-9_|-]+)\)\s+printf/u);
      return match ? match[1].split('|') : [];
    });
  return sortedUnique(commands);
}

function extractTypescriptTopLevelCommands(source: string): string[] {
  const start = source.indexOf('switch (parsed.command)');
  assert.notEqual(start, -1, 'TypeScript CLI command dispatcher was not found.');
  const commands = [...source.slice(start).matchAll(/^\s+case '([^']+)':/gmu)]
    .map((match) => match[1]);
  return sortedUnique(commands);
}

function extractSetConfigValueSource(source: string): string {
  const start = source.indexOf('function setConfigValue(');
  const end = source.indexOf('\nasync function readSingleLineStdin', start);
  assert.notEqual(start, -1, 'setConfigValue() was not found.');
  assert.notEqual(end, -1, 'setConfigValue() end was not found.');
  return source.slice(start, end);
}

function configPathIsImplemented(source: string, configPath: string): boolean {
  if (configPath === 'env.*') return source.includes("key.startsWith('env.')");
  return source.includes(`'${configPath}'`);
}

const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as CliParityContract;
const legacySource = fs.readFileSync(legacyCliPath, 'utf8');
const typescriptSource = fs.readFileSync(typescriptCliPath, 'utf8');

assert.equal(contract.schemaVersion, 1);
assert.deepEqual(
  extractLegacyTopLevelCommands(legacySource),
  sortedUnique(contract.legacyTopLevelCommands),
  'Legacy CLI commands changed without updating the parity contract.',
);
assert.deepEqual(
  extractTypescriptTopLevelCommands(typescriptSource),
  sortedUnique(contract.typescriptTopLevelCommands),
  'TypeScript CLI commands changed without updating the parity contract.',
);

const parityCommands = new Set(contract.topLevelParity.map((entry) => entry.command));
for (const command of contract.legacyTopLevelCommands) {
  assert.ok(parityCommands.has(command), `Legacy command ${command} is missing from topLevelParity.`);
}
for (const command of contract.typescriptTopLevelCommands) {
  assert.ok(parityCommands.has(command), `TypeScript command ${command} is missing from topLevelParity.`);
}

const typescriptCommands = new Set(contract.typescriptTopLevelCommands);
const typescriptSupportedCommands = new Set([...typescriptCommands, 'help', 'version']);
for (const entry of contract.topLevelParity) {
  if (entry.command === 'help' || entry.command === 'version') continue;
  assert.equal(
    typescriptCommands.has(entry.command),
    entry.typescript !== 'missing',
    `TypeScript command status is stale for ${entry.command}.`,
  );
}

const setConfigValueSource = extractSetConfigValueSource(typescriptSource);
for (const entry of contract.configurationPaths) {
  assert.equal(
    configPathIsImplemented(setConfigValueSource, entry.path),
    entry.typescript !== 'missing',
    `TypeScript config-set status is stale for ${entry.path}.`,
  );
}

for (const invocation of contract.controlPlaneInvocations) {
  assert.equal(
    typescriptSupportedCommands.has(invocation.command),
    invocation.currentlySupported,
    `Control Plane command support is stale for ${invocation.command}.`,
  );
}

const missingCommands = contract.topLevelParity
  .filter((entry) => entry.legacy === 'implemented' && entry.typescript === 'missing')
  .map((entry) => entry.command);
const partialCommands = contract.topLevelParity
  .filter((entry) => entry.typescript === 'partial')
  .map((entry) => entry.command);
const missingConfigPaths = contract.configurationPaths
  .filter((entry) => entry.typescript === 'missing')
  .map((entry) => entry.path);

function initialConfig(installDir: string, dataDir: string, hostPort: number, secret: string) {
  return {
    domain: '',
    image: 'ghcr.io/canvascoding/canvas-notebook:latest',
    hostPort,
    containerPort: 3000,
    dataDir,
    platform: { os: 'linux', serviceMode: 'systemd' },
    paths: {
      installDir,
      dataDir,
      configFile: path.join(installDir, 'canvas-notebook-config.json'),
      composeFile: path.join(installDir, 'canvas-notebook-compose.yaml'),
      containerEnvFile: path.join(installDir, 'canvas-notebook.env'),
      composeEnvFile: path.join(installDir, '.env'),
      logFile: path.join(installDir, 'manager.log'),
    },
    swap: { enabled: false, size: '2G', file: '/swapfile', swappiness: 10 },
    autoUpdate: { enabled: false, schedule: '*-*-* 04:00:00' },
    env: {
      BETTER_AUTH_SECRET: 'parity-better-auth-secret',
      CANVAS_INTERNAL_API_KEY: 'parity-internal-api-key',
      CANVAS_INSTANCE_TOKEN: secret,
      BETTER_AUTH_BASE_URL: `http://127.0.0.1:${hostPort}`,
      BASE_URL: `http://127.0.0.1:${hostPort}`,
      PORT: '3000',
      HOSTNAME: '0.0.0.0',
      NODE_ENV: 'production',
      DATA: '/data',
      LOG_LEVEL: 'info',
      ONBOARDING: true,
      ALLOW_SIGNUP: false,
      CANVAS_DEPLOYMENT_MODE: 'single_user',
      CANVAS_DATABASE_PROVIDER: 'sqlite',
      DATABASE_URL: '',
    },
  };
}

async function createFakeHostTools(binDir: string): Promise<void> {
  await fs.promises.mkdir(binDir, { recursive: true });
  const dockerScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'case "${1:-}" in',
    '  info)',
    '    exit 0',
    '    ;;',
    '  compose)',
    '    if [[ " $* " == *" ps -q canvas-notebook "* ]]; then printf "app-container\\n"; fi',
    '    exit 0',
    '    ;;',
    '  inspect)',
    '    format="${3:-}"',
    '    if [[ "$format" == *"\\\"id\\\""* ]]; then',
    '      printf \'%s\\n\' \'{"id":"app-container","name":"/canvas-notebook","status":"running","running":true,"restarting":false,"oomKilled":false,"exitCode":0,"restartCount":0,"image":"ghcr.io/canvascoding/canvas-notebook:latest","imageId":"sha256:running","startedAt":"2026-08-28T00:00:00Z"}\'',
    '    elif [[ "$format" == *".Config.Image"* ]]; then printf "ghcr.io/canvascoding/canvas-notebook:latest\\n"',
    '    elif [[ "$format" == *".State.StartedAt"* ]]; then printf "2026-08-28T00:00:00Z\\n"',
    '    elif [[ "$format" == *".State.Running"* ]]; then printf "true\\n"',
    '    elif [[ "$format" == *".Image"* ]]; then printf "sha256:running\\n"',
    '    fi',
    '    exit 0',
    '    ;;',
    '  image)',
    '    format="${5:-}"',
    '    if [[ "$format" == *"RepoDigests"* ]]; then printf "ghcr.io/canvascoding/canvas-notebook@sha256:local\\n"',
    '    elif [[ "$format" == *".Created"* ]]; then printf "2026-08-28T00:00:00Z\\n"',
    '    else printf "sha256:local\\n"',
    '    fi',
    '    exit 0',
    '    ;;',
    '  exec)',
    '    printf "2026.8.28.0\\n"',
    '    exit 0',
    '    ;;',
    'esac',
    'printf "unexpected docker command: %s\\n" "$*" >&2',
    'exit 1',
    '',
  ].join('\n');
  const systemctlScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ "${1:-}" == "is-active" ]]; then printf "active\\n"; exit 0; fi',
    'exit 0',
    '',
  ].join('\n');
  await Promise.all([
    fs.promises.writeFile(path.join(binDir, 'docker'), dockerScript, { mode: 0o755 }),
    fs.promises.writeFile(path.join(binDir, 'systemctl'), systemctlScript, { mode: 0o755 }),
  ]);
}

function requiredStatusShape(value: unknown) {
  const status = value as Record<string, unknown>;
  assert.equal(typeof status.healthy, 'boolean');
  for (const key of ['serviceActive', 'installDir', 'composeFile', 'dataDir', 'managerLog']) {
    assert.equal(typeof status[key], 'string', `status.${key} must be a string.`);
  }
  const image = status.image as Record<string, unknown>;
  for (const key of ['configuredRef', 'localId', 'localDigest', 'localCreated', 'runningRef', 'runningImageId', 'runningStartedAt', 'appVersion', 'cliVersion']) {
    assert.equal(typeof image[key], 'string', `status.image.${key} must be a string.`);
  }
  const container = status.container as Record<string, unknown>;
  for (const key of ['id', 'name', 'status', 'image', 'imageId', 'startedAt']) {
    assert.equal(typeof container[key], 'string', `status.container.${key} must be a string.`);
  }
  for (const key of ['running', 'restarting', 'oomKilled']) {
    assert.equal(typeof container[key], 'boolean', `status.container.${key} must be a boolean.`);
  }
  for (const key of ['exitCode', 'restartCount']) {
    assert.equal(typeof container[key], 'number', `status.container.${key} must be a number.`);
  }
  return status;
}

async function runDifferentialContract(): Promise<void> {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'canvas-cli-parity-'));
  const healthServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      healthServer.once('error', reject);
      healthServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = healthServer.address();
    assert.ok(address && typeof address === 'object');
    const secret = 'parity-instance-token-must-not-leak';
    const fakeBin = path.join(tempRoot, 'bin');
    await createFakeHostTools(fakeBin);

    async function prepareRuntime(name: string) {
      const installDir = path.join(tempRoot, name, 'install');
      const dataDir = path.join(tempRoot, name, 'data');
      const homeDir = path.join(tempRoot, name, 'home');
      await Promise.all([
        fs.promises.mkdir(installDir, { recursive: true }),
        fs.promises.mkdir(dataDir, { recursive: true }),
        fs.promises.mkdir(homeDir, { recursive: true }),
      ]);
      const configFile = path.join(installDir, 'canvas-notebook-config.json');
      await fs.promises.writeFile(
        configFile,
        `${JSON.stringify(initialConfig(installDir, dataDir, address.port, secret), null, 2)}\n`,
        { mode: 0o600 },
      );
      return {
        installDir,
        configFile,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
          HOME: homeDir,
          CANVAS_INSTALL_DIR: installDir,
          CANVAS_DATA_DIR: dataDir,
          CANVAS_CONFIG_JSON: configFile,
          CANVAS_COMPOSE_FILE: path.join(installDir, 'canvas-notebook-compose.yaml'),
          CANVAS_CONFIG_ENV: path.join(installDir, 'canvas-notebook.env'),
          CANVAS_COMPOSE_ENV: path.join(installDir, '.env'),
          CANVAS_MANAGER_LOG_DIR: installDir,
          CANVAS_MANAGER_LOG_FILE: path.join(installDir, 'manager.log'),
          CANVAS_CONFIG_FILE_OWNER: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          CANVAS_HOST_CODE_OWNER: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          CANVAS_USE_COLOR: 'false',
        },
      };
    }

    const legacyRuntime = await prepareRuntime('legacy');
    const typescriptRuntime = await prepareRuntime('typescript');
    const tsxPath = path.join(root, 'node_modules', '.bin', 'tsx');
    const runLegacy = (args: string[]) => execFileAsync(legacyCliPath, args, {
      cwd: root,
      env: legacyRuntime.env,
      maxBuffer: 1024 * 1024,
    });
    const runTypescript = (args: string[]) => execFileAsync(tsxPath, [typescriptCliPath, ...args], {
      cwd: root,
      env: typescriptRuntime.env,
      maxBuffer: 1024 * 1024,
    });

    const expectedCliVersion = '2026.8.28.99';
    legacyRuntime.env.CANVAS_CLI_VERSION = expectedCliVersion;
    typescriptRuntime.env.CANVAS_CLI_VERSION = expectedCliVersion;
    const legacyVersionOutput = await runLegacy(['version', '--json', '--no-banner']);
    const typescriptVersionOutput = await runTypescript(['version', '--json', '--no-banner']);
    const legacyVersion = JSON.parse(legacyVersionOutput.stdout) as Record<string, unknown>;
    const typescriptVersion = JSON.parse(typescriptVersionOutput.stdout) as Record<string, unknown>;
    for (const key of ['configuredRef', 'localId', 'localDigest', 'localCreated', 'runningRef', 'runningImageId', 'runningStartedAt', 'appVersion', 'cliVersion']) {
      assert.equal(typeof legacyVersion[key], 'string', `legacy version.${key} must be a string.`);
      assert.equal(typeof typescriptVersion[key], 'string', `TypeScript version.${key} must be a string.`);
    }
    assert.equal(typescriptVersion.cliVersion, expectedCliVersion);
    assert.equal(typescriptVersion.runningRef, 'ghcr.io/canvascoding/canvas-notebook:latest');
    assert.equal(typescriptVersion.appVersion, '2026.8.28.0');
    assert.equal(typescriptVersion.cliGeneration, 'typescript');
    assert.equal(typescriptVersion.configSchemaVersion, 1);
    assert.deepEqual(
      sortedUnique(typescriptVersion.commands as string[]),
      sortedUnique([...contract.typescriptTopLevelCommands, 'help', 'version']),
    );
    for (const alias of ['-V', '--version']) {
      const aliasOutput = await runTypescript([alias, '--json']);
      assert.equal((JSON.parse(aliasOutput.stdout) as Record<string, unknown>).cliVersion, expectedCliVersion);
    }

    const packagedRoot = path.join(tempRoot, 'packaged-cli');
    await fs.promises.mkdir(packagedRoot, { recursive: true });
    await fs.promises.cp(path.join(root, 'dist-cli'), path.join(packagedRoot, 'dist-cli'), { recursive: true });
    await fs.promises.writeFile(path.join(packagedRoot, 'VERSION'), '2026.8.28.77\n', 'utf8');
    const packagedEnv = {
      ...typescriptRuntime.env,
      CANVAS_CLI_VERSION: '',
      CANVAS_CLI_ROOT: packagedRoot,
    };
    const runPackaged = (args: string[]) => execFileAsync(
      process.execPath,
      [path.join(packagedRoot, 'dist-cli', 'main.js'), ...args],
      { cwd: tempRoot, env: packagedEnv, maxBuffer: 1024 * 1024 },
    );
    const packagedVersionOutput = await runPackaged(['version', '--json']);
    assert.equal(
      (JSON.parse(packagedVersionOutput.stdout) as Record<string, unknown>).cliVersion,
      '2026.8.28.77',
      'Packaged CLI must resolve its bundled VERSION file without npm environment variables.',
    );
    const packagedStatusOutput = await runPackaged(['status', '--json']);
    const packagedStatus = requiredStatusShape(JSON.parse(packagedStatusOutput.stdout));
    assert.equal(
      (packagedStatus.image as Record<string, unknown>).cliVersion,
      '2026.8.28.77',
      'status --json must expose the packaged CLI version.',
    );

    const configSetCases = [
      ['swap.enabled', 'yes'],
      ['swap.size', '512M'],
      ['swap.file', '/swapfile'],
      ['swap.swappiness', '25'],
      ['autoUpdate.enabled', 'false'],
      ['autoUpdate.schedule', '*-*-* 05:30:00'],
    ];
    for (const [key, value] of configSetCases) {
      await runTypescript(['config-set', key, value, '--no-banner']);
    }
    const typescriptWrittenConfig = JSON.parse(await fs.promises.readFile(typescriptRuntime.configFile, 'utf8')) as {
      swap: Record<string, unknown>;
      autoUpdate: Record<string, unknown>;
    };
    assert.deepEqual(typescriptWrittenConfig.swap, {
      enabled: true,
      size: '512M',
      file: '/swapfile',
      swappiness: 25,
    });
    assert.deepEqual(typescriptWrittenConfig.autoUpdate, {
      enabled: false,
      schedule: '*-*-* 05:30:00',
    });
    const configBeforeRejectedWrites = await fs.promises.readFile(typescriptRuntime.configFile, 'utf8');

    for (const [key, value] of [
      ['swap.enabled', 'sometimes'],
      ['swap.size', '17G'],
      ['swap.file', '/tmp/not-canvas-swap'],
      ['swap.swappiness', '201'],
      ['autoUpdate.enabled', 'sometimes'],
      ['autoUpdate.schedule', 'daily'],
    ]) {
      await assert.rejects(() => runTypescript(['config-set', key, value, '--no-banner']));
    }
    assert.equal(
      await fs.promises.readFile(typescriptRuntime.configFile, 'utf8'),
      configBeforeRejectedWrites,
      'Rejected config-set values must not modify config.json.',
    );

    const legacyConfigOutput = await runLegacy(['config-show', '--json', '--secret-state', '--no-banner']);
    const typescriptConfigOutput = await runTypescript(['config-show', '--json', '--secret-state', '--no-banner']);
    assert.doesNotMatch(legacyConfigOutput.stdout, new RegExp(secret, 'u'));
    assert.doesNotMatch(typescriptConfigOutput.stdout, new RegExp(secret, 'u'));
    const legacyConfig = JSON.parse(legacyConfigOutput.stdout) as Record<string, unknown>;
    const typescriptConfig = JSON.parse(typescriptConfigOutput.stdout) as Record<string, unknown>;
    assert.ok(legacyConfig.secretState);
    assert.ok(typescriptConfig.secretState);

    const legacyStatusOutput = await runLegacy(['status', '--json', '--no-banner']);
    const typescriptStatusOutput = await runTypescript(['status', '--json', '--no-banner']);
    const legacyStatus = requiredStatusShape(JSON.parse(legacyStatusOutput.stdout));
    const typescriptStatus = requiredStatusShape(JSON.parse(typescriptStatusOutput.stdout));
    assert.equal(legacyStatus.healthy, true);
    assert.equal(typescriptStatus.healthy, true);
  } finally {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await runDifferentialContract();
  console.log(JSON.stringify({
    success: true,
    differentialContract: ['version --json', 'config-set swap.*', 'config-set autoUpdate.*', 'config-show --secret-state', 'status --json'],
    legacyCommandCount: contract.legacyTopLevelCommands.length,
    typescriptCommandCount: contract.typescriptTopLevelCommands.length,
    missingCommands,
    partialCommands,
    missingConfigPaths,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
