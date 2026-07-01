#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { materializeConfig, loadConfig, writeConfig, writeEnvFiles } from './core/config';
import { writeComposeFile } from './core/compose';
import { DockerManager } from './core/docker';
import { composePath, createRuntimeContext } from './core/platform';
import { SpawnCommandRunner } from './core/process';
import { ServiceManager } from './core/service';
import type { CanvasCliConfig, RuntimeContext, StatusJson } from './core/types';

interface ParsedArgs {
  command: string;
  args: string[];
  json: boolean;
  noBanner: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let json = false;
  let noBanner = false;
  const filtered: string[] = [];
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      noBanner = true;
    } else if (arg === '--no-banner') {
      noBanner = true;
    } else {
      filtered.push(arg);
    }
  }
  return {
    command: filtered.shift() || 'help',
    args: filtered,
    json,
    noBanner,
  };
}

function printBanner(context: RuntimeContext): void {
  console.log('Canvas Notebook CLI');
  console.log(`Platform: ${context.platform}`);
  console.log('');
}

function printHelp(): void {
  console.log(`Usage: canvas-notebook <command> [options]

Commands:
  install                         Generate config, pull image, start container
  update                          Pull image and recreate only when needed
  start                           Start the container and wait for health
  restart                         Recreate the container and wait for health
  stop                            Stop the app service
  down                            Stop and remove the compose project
  status [--json]                 Show compose/container status
  health [--json]                 Check /api/health
  logs                            Follow app container logs
  manager-log                     Show host-side CLI log
  env --sync                      Regenerate env files
  config-show                     Print canvas-notebook-config.json
  config-set <key> <value>        Set a top-level/env config value
  admin reset-password ...        Reset or create an admin in the container
  database migrate-sqlite-to-postgres [args]
  service status|install|uninstall
`);
}

async function appendLog(context: RuntimeContext, message: string): Promise<void> {
  await fs.mkdir(path.dirname(context.paths.logFile), { recursive: true });
  await fs.appendFile(context.paths.logFile, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

async function readConfig(context: RuntimeContext): Promise<CanvasCliConfig> {
  return loadConfig(context.paths, context.platform);
}

async function syncFiles(context: RuntimeContext, config: CanvasCliConfig): Promise<CanvasCliConfig> {
  const next = materializeConfig(config);
  const composeDataDir = composePath(next.dataDir, context.platform);
  await fs.mkdir(next.paths.installDir, { recursive: true });
  await fs.mkdir(next.paths.dataDir, { recursive: true });
  await writeConfig(next);
  await writeEnvFiles(next, composeDataDir);
  await writeComposeFile(next, context.platform);
  return next;
}

async function install(context: RuntimeContext, docker: DockerManager, config: CanvasCliConfig): Promise<void> {
  await appendLog(context, 'install started');
  const next = await syncFiles(context, config);
  await docker.pull(next);
  await docker.composeOrThrow(next, ['up', '-d', '--force-recreate'], 'inherit');
  await docker.waitUntilHealthy(next);
  await appendLog(context, 'install completed');
  console.log(`Canvas Notebook is healthy: ${docker.healthUrl(next)}`);
}

async function update(context: RuntimeContext, docker: DockerManager, config: CanvasCliConfig): Promise<void> {
  await appendLog(context, 'update started');
  const next = await syncFiles(context, config);
  await docker.pull(next);
  if (await docker.needsRecreate(next)) {
    await docker.composeOrThrow(next, ['up', '-d', '--force-recreate'], 'inherit');
  } else {
    console.log('Container already runs the current healthy image; skipping recreate.');
  }
  await docker.waitUntilHealthy(next);
  await appendLog(context, 'update completed');
  console.log(`Canvas Notebook is healthy: ${docker.healthUrl(next)}`);
}

async function statusJson(context: RuntimeContext, docker: DockerManager, config: CanvasCliConfig): Promise<StatusJson> {
  const [healthy, container] = await Promise.all([
    docker.isHealthy(config),
    docker.inspectContainer(config),
  ]);
  const image = await docker.imageStatus(config, container?.id || '');
  return {
    healthy,
    serviceActive: config.platform.serviceMode,
    installDir: config.paths.installDir,
    composeFile: config.paths.composeFile,
    dataDir: config.dataDir,
    managerLog: context.paths.logFile,
    image,
    container,
  };
}

function setConfigValue(config: CanvasCliConfig, key: string, value: string): CanvasCliConfig {
  const next = structuredClone(config);
  const normalizedValue = value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number(value) : value;
  if (key === 'hostPort' || key === 'containerPort') {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
    next[key] = port;
    return next;
  }
  if (key === 'image' || key === 'domain' || key === 'dataDir') {
    next[key] = String(value);
    if (key === 'dataDir') {
      next.paths.dataDir = String(value);
    }
    return next;
  }
  if (key.startsWith('env.')) {
    next.env[key.slice(4)] = normalizedValue;
    return next;
  }
  throw new Error(`Unsupported config key: ${key}`);
}

async function admin(context: RuntimeContext, docker: DockerManager, config: CanvasCliConfig, args: string[]): Promise<void> {
  const subcommand = args.shift();
  if (subcommand !== 'reset-password' && subcommand !== 'set-password') {
    throw new Error('Usage: canvas-notebook admin reset-password --email <email> [--name <name>] --password-stdin');
  }
  let email = '';
  let name = 'Administrator';
  let passwordStdin = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--email') email = args[++i] || '';
    else if (arg === '--name') name = args[++i] || name;
    else if (arg === '--password-stdin') passwordStdin = true;
    else throw new Error(`Unknown admin option: ${arg}`);
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid --email.');
  if (!passwordStdin) throw new Error('Portable CLI currently requires --password-stdin.');

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '');
  if (password.length < 8 || password.length > 128) throw new Error('Password must be between 8 and 128 characters.');

  const containerId = await docker.containerId(config);
  if (!containerId) throw new Error('Canvas Notebook container is not running. Start it first: canvas-notebook start');
  await docker.dockerOrThrow([
    'exec',
    '-i',
    containerId,
    'node',
    'scripts/bootstrap-admin.js',
    '--email',
    email,
    '--name',
    name,
    '--password-stdin',
  ], { stdin: `${password}\n`, stdio: 'pipe' });
  await appendLog(context, `admin reset-password ${email}`);
  console.log(`Admin credentials synchronized for ${email}`);
}

async function database(docker: DockerManager, config: CanvasCliConfig, args: string[], json: boolean): Promise<void> {
  const subcommand = args.shift();
  if (subcommand !== 'migrate-sqlite-to-postgres') {
    throw new Error('Usage: canvas-notebook database migrate-sqlite-to-postgres [options]');
  }
  const containerId = await docker.containerId(config);
  if (!containerId) throw new Error('Canvas Notebook container is not running. Start it first: canvas-notebook start');
  const nextArgs = json ? [...args, '--json'] : args;
  await docker.dockerOrThrow([
    'exec',
    containerId,
    'npx',
    'tsx',
    '--conditions',
    'react-server',
    'scripts/migrate-sqlite-to-postgres.ts',
    ...nextArgs,
  ], { stdio: 'inherit' });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const context = createRuntimeContext();
  const runner = new SpawnCommandRunner();
  const docker = new DockerManager(runner, context);
  const services = new ServiceManager(runner, context);

  if (!parsed.noBanner && parsed.command !== 'help') printBanner(context);

  if (parsed.command === 'help' || parsed.command === '-h' || parsed.command === '--help') {
    printHelp();
    return;
  }

  const config = await readConfig(context);

  switch (parsed.command) {
    case 'install':
      await install(context, docker, config);
      break;
    case 'update':
      await update(context, docker, config);
      break;
    case 'start': {
      const next = await syncFiles(context, config);
      await appendLog(context, 'start');
      await docker.composeOrThrow(next, ['up', '-d'], 'inherit');
      await docker.waitUntilHealthy(next);
      console.log(`Canvas Notebook is healthy: ${docker.healthUrl(next)}`);
      break;
    }
    case 'restart': {
      const next = await syncFiles(context, config);
      await appendLog(context, 'restart');
      await docker.composeOrThrow(next, ['up', '-d', '--force-recreate'], 'inherit');
      await docker.waitUntilHealthy(next);
      console.log(`Canvas Notebook is healthy: ${docker.healthUrl(next)}`);
      break;
    }
    case 'stop':
      await appendLog(context, 'stop');
      await docker.composeOrThrow(config, ['stop', context.serviceName], 'inherit');
      break;
    case 'down':
      await appendLog(context, 'down');
      await docker.composeOrThrow(config, ['down'], 'inherit');
      break;
    case 'status':
    case 'ps':
      if (parsed.json) {
        console.log(JSON.stringify(await statusJson(context, docker, config)));
      } else {
        await docker.composeOrThrow(config, ['ps'], 'inherit');
      }
      break;
    case 'health': {
      const healthy = await docker.isHealthy(config);
      if (parsed.json) console.log(JSON.stringify({ healthy }));
      else if (healthy) console.log(`ok ${docker.healthUrl(config)}`);
      if (!healthy) process.exitCode = 1;
      break;
    }
    case 'logs':
    case 'container-logs':
      await docker.composeOrThrow(config, ['logs', '-f', '--tail=120', context.serviceName], 'inherit');
      break;
    case 'manager-log':
      console.log(await fs.readFile(context.paths.logFile, 'utf8').catch(() => ''));
      break;
    case 'env':
      if (!parsed.args.includes('--sync')) throw new Error('Usage: canvas-notebook env --sync');
      await syncFiles(context, config);
      console.log(`Generated ${config.paths.composeEnvFile} and ${config.paths.containerEnvFile}`);
      break;
    case 'config-show':
      console.log(JSON.stringify(config, null, 2));
      break;
    case 'config-set': {
      const [key, value] = parsed.args;
      if (!key || value === undefined) throw new Error('Usage: canvas-notebook config-set <key> <value>');
      const next = await syncFiles(context, setConfigValue(config, key, value));
      console.log(`Set ${key} in ${next.paths.configFile}`);
      break;
    }
    case 'admin':
      await admin(context, docker, config, parsed.args);
      break;
    case 'database':
      await database(docker, config, parsed.args, parsed.json);
      break;
    case 'service': {
      const action = parsed.args[0] || 'status';
      if (action === 'status') console.log(await services.status(config));
      else if (action === 'install') console.log(await services.install(config));
      else if (action === 'uninstall') console.log(await services.uninstall(config));
      else throw new Error('Usage: canvas-notebook service status|install|uninstall');
      break;
    }
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
