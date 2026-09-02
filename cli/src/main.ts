#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  configSecretState,
  configureRuntimeAndDatabase,
  createDefaultConfig,
  ensurePostgresInfrastructureConfig,
  materializeConfig,
  materializePostgresInfrastructureConfig,
  isSensitiveEnvKey,
  isPinnedImageReference,
  loadConfig,
  normalizeConfig,
  parseCliDatabaseProvider,
  parseCliPostgresMode,
  parseCliRuntimeMode,
  redactConfig,
  writeConfig,
  writeEnvFiles,
  writeSecureFile,
  type CliDatabaseProvider,
  type CliPostgresMode,
  type CliRuntimeMode,
} from './core/config';
import { AutoUpdateManager, isAutoUpdateCommand, validateAutoUpdateSchedule, type AutoUpdateStatus } from './core/autoUpdate';
import { CaddyManager, isCaddyCommand, type CaddyStatus } from './core/caddy';
import { writeComposeFile } from './core/compose';
import { monotonicDeadlineMs, remainingMonotonicSeconds } from './core/deadline';
import { collectHostResources } from './core/diagnostics';
import { DockerManager } from './core/docker';
import { migrateLegacyConfig } from './core/legacyConfig';
import { cleanupOrphanedLogFollowers } from './core/logCleanup';
import {
  acquireOperationLock,
  commandCanRunWithPendingPostgresRecovery,
  commandRequiresOperationLock,
} from './core/operationLock';
import { composePath, createRuntimeContext } from './core/platform';
import { externalPostgresRuntimeDesired, preparePostgresManagedRuntime, postgresRuntimeDesired, postgresRuntimeInitialized } from './core/postgres';
import { preflightExternalPostgres, type PgvectorPolicy } from './core/postgresPreflight';
import {
  assertPostgresRecoveryCompatible,
  clearPostgresRecoveryJournal,
  createPostgresRecoverySnapshot,
  hasPostgresRecoveryJournal,
  readPostgresRecoverySnapshot,
  readPostgresRecoveryJournal,
  restorePostgresRecoverySnapshot,
  writePostgresRecoveryJournal,
  type PostgresRecoveryJournal,
  type PostgresRecoverySnapshot,
} from './core/postgresRecovery';
import { SpawnCommandRunner } from './core/process';
import { reexecPortableCliIfUpdated, updatePortableCli } from './core/selfUpdate';
import { ServiceManager } from './core/service';
import { isSwapCommand, SwapManager, validateSwapConfig, type SwapStatus } from './core/swap';
import type { CanvasCliConfig, RuntimeContext, StatusJson } from './core/types';
import { CLI_COMMANDS, CLI_GENERATION, CONFIG_SCHEMA_VERSION, resolveCliVersion } from './core/version';

interface ParsedArgs {
  command: string;
  args: string[];
  json: boolean;
  noBanner: boolean;
  versionRequested: boolean;
}

interface InstallOptions {
  database?: CliDatabaseProvider;
  databaseUrlSource?: { type: 'stdin' } | { type: 'file'; filePath: string };
  pgvectorPolicy?: PgvectorPolicy;
  postgresMode?: CliPostgresMode;
  runtime?: CliRuntimeMode;
}

interface BackupCreateOptions {
  output?: string;
  noWait: boolean;
  keepJobArtifacts: boolean;
}

interface EnvOptions {
  mode: 'display' | 'render' | 'sync' | 'edit';
  timeoutSeconds: number;
}

export interface UpdateOptions {
  image?: string;
  requirePinned?: boolean;
}

interface UpdateDeadline {
  deadlineMs: number | null;
  rollbackReserveMs: number;
}

const LATEST_BACKUP_FILE_NAME = 'canvas-notebook-backup-latest.zip';

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let json = false;
  let noBanner = false;
  let versionRequested = false;
  const filtered: string[] = [];
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      noBanner = true;
    } else if (arg === '--no-banner') {
      noBanner = true;
    } else if (arg === '-V' || arg === '--version') {
      versionRequested = true;
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
    versionRequested,
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
  version [--json]                 Show CLI build information and capabilities
  install [--database postgres] [--postgres-mode managed|external] [--database-url-stdin|--database-url-file <path>] [--pgvector required|optional|disabled] [--runtime personal|team]
                                  Generate config, pull image, start container
  update [--image <name@sha256>] [--require-pinned]
                                 Pull and apply an image with rollback protection
  start                           Start the container and wait for health
  restart                         Recreate the container and wait for health
  stop                            Stop the app service
  down                            Stop and remove the compose project
  status [--json]                 Show compose/container status
  health [--json]                 Check /api/health
  diagnose [--json]               Show tolerant host, Docker, and app diagnostics
  logs                            Follow app container logs
  manager-log                     Show host-side CLI log
  cleanup-logs [--json]           Stop only orphaned log followers for this installation
  swap [--json]                   Show Canvas-managed Linux swap status
  swap-sync [--json]              Reconcile Linux swap from the saved configuration
  swap-apply --enabled <bool> --size <size> --file <path> --swappiness <0-200>
                                  Save settings and reconcile Linux swap transactionally
  swap-enable [--size <size>] [--file <path>] [--swappiness <0-200>]
  swap-disable [--secure]         Disable managed swap; optionally wipe its contents
  caddy [--json]                  Show Linux Caddy status and the active Caddyfile
  caddy-reload [--json]           Validate and apply the managed Canvas Caddy site
  caddy-fix [--json]              Repair known Canvas/default Caddy configuration
  auto-update-status [--json]     Show Linux systemd auto-update status
  auto-update-enable [--schedule <calendar>] [--json]
                                  Install and enable the autonomous update timer
  auto-update-disable [--json]    Disable autonomous updates safely
  auto-update-sync [--json]       Reconcile config and systemd timer state
  env [--json]                    Show the active configuration with secrets masked
  env --edit [--timeout <seconds>]
                                  Edit config safely, then apply and wait for health
  env --render | env --sync --timeout <seconds>
                                  Render only, or apply safely and wait for health
  config-show --json --secret-state
                                  Print masked config; optionally include secret fingerprints
  config-set <key> <value> | config-set <key> --stdin
                                  Set a config value; --stdin avoids secret argv exposure
  config [--json]                 Show active host configuration paths
  config-migrate [--force]       Import legacy manager, Compose, and env configuration
  cli-update                      Update the portable management CLI bundle
  admin reset-password ...        Reset or create an admin in the container
  backup create [--output <path>] Create/replace the local latest full backup
  database status [--json]        Show configured database provider status
  database validate [--json]      Validate external Postgres connectivity and capabilities
  database prepare-postgres --timeout <seconds>
                                  Prepare local Postgres without requiring old credentials
  database reconcile-postgres-auth --timeout <seconds>
                                  Reconcile Postgres auth, then apply the app
  database migrate-sqlite-to-postgres [args]
  service status|install|uninstall
`);
}

async function printVersion(
  context: RuntimeContext,
  docker: DockerManager,
  json: boolean,
): Promise<void> {
  const cliVersion = await resolveCliVersion();
  const config = await readConfig(context).catch(() => createDefaultConfig(context.paths, context.platform));
  const containerId = await docker.containerId(config).catch(() => '');
  const image = await docker.imageStatus(config, containerId).catch(() => ({
    configuredRef: config.image,
    localId: '',
    localDigest: '',
    localCreated: '',
    runningRef: '',
    runningImageId: '',
    runningStartedAt: '',
    appVersion: '',
    cliVersion,
  }));
  const payload = {
    ...image,
    cliVersion,
    cliGeneration: CLI_GENERATION,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    commands: [...CLI_COMMANDS],
  };
  if (json) {
    console.log(JSON.stringify(payload));
    return;
  }
  console.log(`CLI version: ${payload.cliVersion}`);
  console.log(`CLI generation: ${payload.cliGeneration}`);
  console.log(`Config schema version: ${payload.configSchemaVersion}`);
  console.log(`Capabilities: ${payload.commands.join(', ')}`);
  console.log(`Configured image: ${payload.configuredRef || 'unknown'}`);
  console.log(`Pulled image digest: ${payload.localDigest || 'unknown'}`);
  console.log(`Pulled image ID: ${payload.localId || 'unknown'}`);
  console.log(`Pulled image created: ${payload.localCreated || 'unknown'}`);
  console.log(`Running image: ${payload.runningRef || 'not running'}`);
  console.log(`Running image ID: ${payload.runningImageId || 'not running'}`);
  console.log(`Running app version: ${payload.appVersion || 'unknown'}`);
  console.log(`Container started: ${payload.runningStartedAt || 'not running'}`);
}

async function appendLog(context: RuntimeContext, message: string): Promise<void> {
  await fs.mkdir(path.dirname(context.paths.logFile), { recursive: true });
  await fs.appendFile(context.paths.logFile, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

async function readConfig(context: RuntimeContext): Promise<CanvasCliConfig> {
  return loadConfig(context.paths, context.platform);
}

async function syncFiles(
  context: RuntimeContext,
  config: CanvasCliConfig,
  options: { postgresInfrastructureOnly?: boolean; allowPostgresSecretGeneration?: boolean } = {},
): Promise<CanvasCliConfig> {
  const next = options.postgresInfrastructureOnly
    ? materializePostgresInfrastructureConfig(config)
    : materializeConfig(config, undefined, { allowPostgresSecretGeneration: options.allowPostgresSecretGeneration ?? false });
  const composeDataDir = composePath(next.dataDir, context.platform);
  await fs.mkdir(next.paths.installDir, { recursive: true });
  await fs.mkdir(next.paths.dataDir, { recursive: true });
  await writeConfig(next);
  await writeEnvFiles(next, composeDataDir);
  await writeComposeFile(next, context.platform);
  return next;
}

async function renderEnvFiles(
  context: RuntimeContext,
  config: CanvasCliConfig,
): Promise<{ config: CanvasCliConfig; filesChanged: boolean }> {
  const next = materializeConfig(config, undefined, { allowPostgresSecretGeneration: false });
  const composeDataDir = composePath(next.dataDir, context.platform);
  const [beforeContainerEnv, beforeComposeEnv] = await Promise.all([
    fs.readFile(next.paths.containerEnvFile, 'utf8').catch(() => null),
    fs.readFile(next.paths.composeEnvFile, 'utf8').catch(() => null),
  ]);
  await fs.mkdir(next.paths.installDir, { recursive: true });
  await fs.mkdir(next.paths.dataDir, { recursive: true });
  await writeConfig(next);
  await writeEnvFiles(next, composeDataDir);
  const [afterContainerEnv, afterComposeEnv] = await Promise.all([
    fs.readFile(next.paths.containerEnvFile, 'utf8'),
    fs.readFile(next.paths.composeEnvFile, 'utf8'),
  ]);
  return {
    config: next,
    filesChanged: beforeContainerEnv !== afterContainerEnv || beforeComposeEnv !== afterComposeEnv,
  };
}

function readOptionValue(args: string[], index: number, option: string): { value: string; nextIndex: number } {
  const inlinePrefix = `${option}=`;
  const current = args[index] || '';
  if (current.startsWith(inlinePrefix)) {
    const value = current.slice(inlinePrefix.length);
    if (!value) throw new Error(`Missing value for ${option}.`);
    return { value, nextIndex: index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
  return { value, nextIndex: index + 1 };
}

function parseInstallOptions(args: string[]): InstallOptions {
  const options: InstallOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--database' || arg.startsWith('--database=')) {
      const parsed = readOptionValue(args, i, '--database');
      options.database = parseCliDatabaseProvider(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--postgres-mode' || arg.startsWith('--postgres-mode=')) {
      const parsed = readOptionValue(args, i, '--postgres-mode');
      options.postgresMode = parseCliPostgresMode(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--database-url-stdin') {
      if (options.databaseUrlSource) throw new Error('Choose only one external DATABASE_URL input source.');
      options.databaseUrlSource = { type: 'stdin' };
    } else if (arg === '--database-url-file' || arg.startsWith('--database-url-file=')) {
      if (options.databaseUrlSource) throw new Error('Choose only one external DATABASE_URL input source.');
      const parsed = readOptionValue(args, i, '--database-url-file');
      options.databaseUrlSource = { type: 'file', filePath: parsed.value };
      i = parsed.nextIndex;
    } else if (arg === '--pgvector' || arg.startsWith('--pgvector=')) {
      const parsed = readOptionValue(args, i, '--pgvector');
      if (parsed.value !== 'required' && parsed.value !== 'optional' && parsed.value !== 'disabled') {
        throw new Error('--pgvector must be required, optional, or disabled.');
      }
      options.pgvectorPolicy = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--runtime' || arg.startsWith('--runtime=')) {
      const parsed = readOptionValue(args, i, '--runtime');
      options.runtime = parseCliRuntimeMode(parsed.value);
      i = parsed.nextIndex;
    } else {
      throw new Error(`Unknown install option: ${arg}`);
    }
  }
  return options;
}

function parseEnvOptions(args: string[], json: boolean): EnvOptions {
  let render = false;
  let sync = false;
  let edit = false;
  let timeoutSeconds = Number(process.env.CANVAS_ENV_SYNC_TIMEOUT || 900);
  let timeoutSet = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--render') {
      render = true;
    } else if (arg === '--sync') {
      sync = true;
    } else if (arg === '--edit') {
      edit = true;
    } else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const parsed = readOptionValue(args, i, '--timeout');
      timeoutSeconds = Number(parsed.value);
      timeoutSet = true;
      i = parsed.nextIndex;
    } else {
      throw new Error(`Unknown env option: ${arg}`);
    }
  }
  if (render && sync) throw new Error('--render and --sync are mutually exclusive.');
  if (render && edit) throw new Error('--edit cannot be combined with --render.');
  if (edit && json) throw new Error('--edit cannot be combined with --json.');
  const mode: EnvOptions['mode'] = edit ? 'edit' : sync ? 'sync' : render ? 'render' : 'display';
  if (timeoutSet && mode !== 'sync' && mode !== 'edit') throw new Error('--timeout requires --sync or --edit.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) {
    throw new Error('--timeout must be an integer from 1 to 7200 seconds.');
  }
  return { mode, timeoutSeconds };
}

function parseUpdateOptions(args: string[]): UpdateOptions {
  const options: UpdateOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--image' || arg.startsWith('--image=')) {
      if (options.image) throw new Error('--image can only be provided once.');
      const parsed = readOptionValue(args, i, '--image');
      options.image = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--require-pinned') {
      options.requirePinned = true;
    } else {
      throw new Error(`Unknown update option: ${arg}`);
    }
  }
  if (options.image && !isPinnedImageReference(options.image)) {
    throw new Error('--image must be an OCI image name pinned to a sha256 digest.');
  }
  return options;
}

function updatePostgresTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const timeoutSeconds = Number(env.CANVAS_UPDATE_POSTGRES_TIMEOUT || 900);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) {
    throw new Error('CANVAS_UPDATE_POSTGRES_TIMEOUT must be an integer from 1 to 7200 seconds.');
  }
  return timeoutSeconds;
}

function updateDeadline(env: NodeJS.ProcessEnv = process.env): UpdateDeadline {
  const rawDeadline = String(env.CANVAS_UPDATE_DEADLINE_EPOCH_MS || '').trim();
  const rollbackReserveSeconds = Number(env.CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS || 120);
  if (!Number.isInteger(rollbackReserveSeconds) || rollbackReserveSeconds < 30 || rollbackReserveSeconds > 1800) {
    throw new Error('CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS must be an integer from 30 to 1800 seconds.');
  }
  if (!rawDeadline) return { deadlineMs: null, rollbackReserveMs: rollbackReserveSeconds * 1000 };
  const deadlineMs = Number(rawDeadline);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() + rollbackReserveSeconds * 1000) {
    throw new Error('CANVAS_UPDATE_DEADLINE_EPOCH_MS must be a future epoch-millisecond deadline beyond the rollback reserve.');
  }
  return { deadlineMs, rollbackReserveMs: rollbackReserveSeconds * 1000 };
}

function remainingUpdateTime(deadline: UpdateDeadline, reserveRollback: boolean): number | undefined {
  if (deadline.deadlineMs === null) return undefined;
  const remaining = deadline.deadlineMs - Date.now() - (reserveRollback ? deadline.rollbackReserveMs : 0);
  if (remaining < 1000) throw new Error(reserveRollback
    ? 'Update forward deadline exhausted; rollback reserve is now active.'
    : 'Update rollback deadline exhausted.');
  return remaining;
}

function boundedHealthAttempts(timeoutMs: number | undefined): number {
  const configured = Number(process.env.CANVAS_HEALTH_MAX_ATTEMPTS || 180);
  const safeConfigured = Number.isInteger(configured) && configured > 0 ? configured : 180;
  return timeoutMs === undefined ? safeConfigured : Math.max(1, Math.min(safeConfigured, Math.floor(timeoutMs / 1000)));
}

function managedByControlPlane(config: CanvasCliConfig): boolean {
  const managed = String(config.env.CANVAS_MANAGED_SERVICES_ENABLED || '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(managed) || String(config.env.CANVAS_CONTROL_PLANE_URL || '').trim().length > 0;
}

function printEnvironment(config: CanvasCliConfig, json: boolean): void {
  const masked = redactConfig(config);
  if (json) {
    console.log(JSON.stringify(masked));
    return;
  }
  console.log(`Config: ${config.paths.configFile}`);
  console.log(`Container env: ${config.paths.containerEnvFile}`);
  console.log(`Compose env: ${config.paths.composeEnvFile}`);
  console.log('');
  for (const key of ['domain', 'image', 'hostPort', 'containerPort', 'dataDir'] as const) {
    console.log(`${key}=${String(masked[key] || '(not set)')}`);
  }
  for (const [key, value] of Object.entries(masked.env).sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`${key}=${String(value || '(not set)')}`);
  }
  console.log(`swap.enabled=${masked.swap.enabled}`);
  console.log(`swap.size=${masked.swap.size}`);
  console.log(`swap.file=${masked.swap.file}`);
  console.log(`swap.swappiness=${masked.swap.swappiness}`);
  console.log(`autoUpdate.enabled=${masked.autoUpdate.enabled}`);
  console.log(`autoUpdate.schedule=${masked.autoUpdate.schedule}`);
}

async function editConfig(
  context: RuntimeContext,
  runner: SpawnCommandRunner,
  config: CanvasCliConfig,
): Promise<CanvasCliConfig> {
  const explicitEditor = String(process.env.VISUAL || process.env.EDITOR || '').trim();
  const editor = explicitEditor || (context.platform === 'windows' ? 'notepad.exe' : 'vi');
  if (/\0|\r|\n/u.test(editor)) throw new Error('EDITOR contains unsupported control characters.');

  await fs.mkdir(config.paths.installDir, { recursive: true });
  const temporaryDirectory = await fs.mkdtemp(path.join(config.paths.installDir, '.canvas-env-edit-'));
  const temporaryConfig = path.join(temporaryDirectory, 'canvas-notebook-config.json');
  try {
    await fs.chmod(temporaryDirectory, 0o700);
    await writeSecureFile(temporaryConfig, `${JSON.stringify(config, null, 2)}\n`);
    const result = await runner.run(editor, [temporaryConfig], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Editor exited with status ${result.status}.`);

    const edited = JSON.parse(await fs.readFile(temporaryConfig, 'utf8')) as unknown;
    const next = normalizeConfig(edited, config);
    next.platform = { ...config.platform };
    next.paths = { ...config.paths, dataDir: next.dataDir };
    await writeConfig(next);
    return next;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Edited configuration is not valid JSON.');
    throw error;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function runEnvCommand(
  context: RuntimeContext,
  runner: SpawnCommandRunner,
  docker: DockerManager,
  config: CanvasCliConfig,
  args: string[],
  json: boolean,
): Promise<void> {
  let phase = 'arguments';
  let postgresAuthReconciled = false;
  try {
    const options = parseEnvOptions(args, json);
    if (options.mode === 'display') {
      printEnvironment(config, json);
      return;
    }
    if (await hasPostgresRecoveryJournal(config)) {
      if (options.mode !== 'sync' && options.mode !== 'edit') {
        phase = 'recovery';
        throw new Error('An interrupted Postgres auth reconciliation is pending; env --render is blocked.');
      }
      phase = 'recovery';
      await reconcilePostgresAuth(context, docker, config, ['--timeout', String(options.timeoutSeconds)], json, true);
      config = await readConfig(context);
      postgresAuthReconciled = true;
    } else if ((options.mode === 'sync' || options.mode === 'edit') && postgresRuntimeDesired(config)) {
      const existingEnvFiles = await Promise.all([
        fs.access(config.paths.containerEnvFile).then(() => true, () => false),
        fs.access(config.paths.composeEnvFile).then(() => true, () => false),
      ]);
      if (existingEnvFiles.every(Boolean)) {
        phase = 'postgres';
        await reconcilePostgresAuth(context, docker, config, ['--timeout', String(options.timeoutSeconds)], json, true);
        config = await readConfig(context);
        postgresAuthReconciled = true;
      }
    }
    if (options.mode === 'edit') {
      phase = 'edit';
      config = await editConfig(context, runner, config);
    }
    phase = 'render';
    const rendered = await renderEnvFiles(context, config);
    if (options.mode === 'render') {
      const result = { success: true, rendered: true, restarted: false, filesChanged: rendered.filesChanged };
      console.log(json ? JSON.stringify(result) : 'Environment files rendered without restarting containers.');
      return;
    }

    phase = 'compose';
    await writeComposeFile(rendered.config, context.platform);
    const beforeContainer = await docker.containerId(rendered.config);
    const beforeRunning = await docker.isContainerRunning(beforeContainer);
    phase = 'postgres';
    const postgres = postgresAuthReconciled
      ? { desired: true }
      : await preparePostgresManagedRuntime({
        docker,
        config: rendered.config,
        stdio: json ? 'pipe' : 'inherit',
      });
    phase = 'app';
    await docker.composeOrThrow(rendered.config, ['up', '-d', '--no-deps', context.serviceName], json ? 'pipe' : 'inherit');
    const afterContainer = await docker.containerId(rendered.config);
    phase = 'health';
    await docker.waitUntilHealthy(rendered.config, options.timeoutSeconds, options.timeoutSeconds * 1000);
    const result = {
      success: true,
      rendered: true,
      restarted: !beforeRunning || beforeContainer !== afterContainer,
      filesChanged: rendered.filesChanged,
      postgresReconciled: postgres.desired,
      healthy: true,
      timeoutSeconds: options.timeoutSeconds,
    };
    console.log(json ? JSON.stringify(result) : 'Canvas Notebook environment applied and healthy.');
  } catch (error) {
    if (!json) throw error;
    const messages: Record<string, string> = {
      arguments: error instanceof Error ? error.message : 'Invalid environment options.',
      render: 'Environment render failed.',
      compose: 'Compose configuration failed.',
      postgres: 'Postgres credential reconciliation failed.',
      recovery: error instanceof Error ? error.message : 'Interrupted Postgres auth reconciliation could not be completed.',
      edit: error instanceof Error ? error.message : 'Configuration edit failed.',
      app: 'Canvas Notebook apply failed.',
      health: 'Canvas Notebook did not become healthy within the configured timeout.',
    };
    console.log(JSON.stringify({ success: false, phase, error: messages[phase] || 'Environment synchronization failed.' }));
    process.exitCode = 1;
  }
}

function parseBackupCreateOptions(args: string[]): BackupCreateOptions {
  const options: BackupCreateOptions = {
    noWait: false,
    keepJobArtifacts: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--output' || arg.startsWith('--output=')) {
      const parsed = readOptionValue(args, i, '--output');
      options.output = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--no-wait') {
      options.noWait = true;
    } else if (arg === '--keep-job-artifacts') {
      options.keepJobArtifacts = true;
    } else {
      throw new Error(`Unknown backup create option: ${arg}`);
    }
  }
  if (options.output && options.noWait) {
    throw new Error('--output cannot be combined with --no-wait.');
  }
  return options;
}

async function copyFileAtomically(sourcePath: string, requestedOutputPath: string): Promise<string> {
  let outputPath = path.resolve(requestedOutputPath);
  const outputStat = await fs.stat(outputPath).catch(() => null);
  if (outputStat?.isDirectory()) {
    outputPath = path.join(outputPath, LATEST_BACKUP_FILE_NAME);
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.next-${process.pid}-${Date.now()}`,
  );
  try {
    await fs.copyFile(sourcePath, tempPath);
    await fs.chmod(tempPath, 0o600).catch(() => undefined);
    await fs.rename(tempPath, outputPath);
    return outputPath;
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function install(
  context: RuntimeContext,
  docker: DockerManager,
  config: CanvasCliConfig,
  options: { pgvectorPolicy?: PgvectorPolicy } = {},
): Promise<void> {
  await appendLog(context, 'install started');
  if (managedByControlPlane(config)) {
    console.log('Note: This installation is managed by Control Plane; autonomous CLI auto-update is disabled.');
    await appendLog(context, 'managed mode: autonomous auto-update disabled');
  }
  if (externalPostgresRuntimeDesired(config)) {
    await docker.dockerOrThrow(['pull', config.image], { stdio: 'inherit' });
    const pgvectorPolicy = options.pgvectorPolicy ?? 'required';
    const preflight = await preflightExternalPostgres({ config, docker, pgvectorPolicy });
    config.env.CANVAS_POSTGRES_VECTOR_ENABLED = pgvectorPolicy !== 'disabled' && preflight.pgvectorAvailable;
  }
  const next = await syncFiles(context, config, { allowPostgresSecretGeneration: true });
  if (!externalPostgresRuntimeDesired(next)) await docker.pull(next);
  await preparePostgresManagedRuntime({ docker, config: next, stdio: 'inherit' });
  await docker.composeOrThrow(next, ['up', '-d', '--force-recreate'], 'inherit');
  await docker.waitUntilHealthy(next);
  await appendLog(context, 'install completed');
  console.log(`Canvas Notebook is healthy: ${docker.healthUrl(next)}`);
}

export async function update(
  context: RuntimeContext,
  docker: DockerManager,
  config: CanvasCliConfig,
  json: boolean,
  options: UpdateOptions,
): Promise<void> {
  await appendLog(context, 'update started');
  if (managedByControlPlane(config)) {
    await appendLog(context, 'managed mode: update coordinated by Control Plane');
    if (!json) {
      console.log('Managed mode: this update is coordinated by the Control Plane; autonomous auto-update remains disabled.');
    }
  }
  const previousConfigImage = config.image;
  const targetImage = options.image || previousConfigImage;
  if ((options.requirePinned || managedByControlPlane(config)) && !isPinnedImageReference(targetImage)) {
    throw new Error('Managed and scheduled updates require an image pinned to a sha256 digest.');
  }
  const previousContainer = await docker.containerId(config);
  const previousImageId = await docker.containerImageId(previousContainer);
  let phase = 'render';
  let appliedNewImage = false;
  let recreated = false;
  let deadline: UpdateDeadline = { deadlineMs: null, rollbackReserveMs: 120000 };
  try {
    phase = 'arguments';
    deadline = updateDeadline();
    if (postgresRuntimeDesired(config)) {
      phase = 'postgres_auth';
      const forwardTimeoutMs = remainingUpdateTime(deadline, true);
      const postgresTimeout = Math.min(
        updatePostgresTimeoutSeconds(),
        forwardTimeoutMs === undefined ? 7200 : Math.max(1, Math.floor(forwardTimeoutMs / 1000)),
      );
      await reconcilePostgresAuth(
        context,
        docker,
        config,
        ['--timeout', String(postgresTimeout)],
        json,
        true,
      );
      config = await readConfig(context);
    }
    remainingUpdateTime(deadline, true);
    const next = await syncFiles(context, config);
    const runConfig = structuredClone(next);
    runConfig.image = targetImage;
    const targetEnvironment = { ...process.env, CANVAS_IMAGE: targetImage };
    phase = 'pull';
    await docker.pull(runConfig, json ? 'pipe' : 'inherit', remainingUpdateTime(deadline, true), targetEnvironment);
    if (await docker.needsRecreate(runConfig)) {
      phase = 'apply';
      appliedNewImage = true;
      await docker.composeOrThrow(
        runConfig,
        ['up', '-d', '--force-recreate', '--no-deps', context.serviceName],
        json ? 'pipe' : 'inherit',
        remainingUpdateTime(deadline, true),
        targetEnvironment,
      );
      recreated = true;
    } else if (!json) {
      console.log('Container already runs the current healthy image; skipping recreate.');
    }
    phase = 'health';
    const forwardHealthTimeout = remainingUpdateTime(deadline, true);
    await docker.waitUntilHealthy(runConfig, boundedHealthAttempts(forwardHealthTimeout), forwardHealthTimeout);
    if (options.image) {
      phase = 'finalize';
      const finalizeTimeout = remainingUpdateTime(deadline, true);
      const persisted = await readConfig(context);
      if (previousConfigImage.includes('@sha256:')) {
        persisted.image = targetImage;
      } else {
        const targetImageId = await docker.imageId(targetImage);
        if (!targetImageId) throw new Error('Pinned image could not be resolved after the update.');
        await docker.dockerOrThrow(['image', 'tag', targetImageId, previousConfigImage], { stdio: 'pipe', timeoutMs: finalizeTimeout });
        persisted.image = previousConfigImage;
      }
      await writeConfig(persisted);
      await writeEnvFiles(persisted, composePath(persisted.dataDir, context.platform));
    }
    await docker.pruneUnusedImages(remainingUpdateTime(deadline, true));
    await appendLog(context, 'update completed');
    if (json) console.log(JSON.stringify({ success: true, recreated, healthy: true, rolledBack: false }));
    else console.log(`Canvas Notebook is healthy: ${docker.healthUrl(runConfig)}`);
  } catch {
    let rolledBack = false;
    if (appliedNewImage && previousImageId) {
      try {
        const rollback = await readConfig(context);
        rollback.image = previousConfigImage;
        if (!previousConfigImage.includes('@sha256:')) {
          await docker.dockerOrThrow(['image', 'tag', previousImageId, previousConfigImage], {
            stdio: 'pipe',
            timeoutMs: remainingUpdateTime(deadline, false),
          });
        }
        await writeConfig(rollback);
        await writeEnvFiles(rollback, composePath(rollback.dataDir, context.platform));
        await docker.composeOrThrow(
          rollback,
          ['up', '-d', '--force-recreate', '--no-deps', context.serviceName],
          'pipe',
          remainingUpdateTime(deadline, false),
        );
        const rollbackHealthTimeout = remainingUpdateTime(deadline, false);
        await docker.waitUntilHealthy(rollback, boundedHealthAttempts(rollbackHealthTimeout), rollbackHealthTimeout);
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    }
    const failurePhase = appliedNewImage && !rolledBack ? 'rollback_failed' : phase;
    const message = rolledBack
      ? 'Updated image failed; the previous image was restored.'
      : (appliedNewImage
        ? 'Updated image failed and the previous image could not be restored.'
        : `Update failed during ${phase}; the running container was not changed.`);
    if (json) {
      console.log(JSON.stringify({ success: false, phase: failurePhase, error: message, rolledBack }));
      process.exitCode = 1;
      return;
    }
    throw new Error(message);
  }
}

async function statusJson(
  context: RuntimeContext,
  docker: DockerManager,
  services: ServiceManager,
  config: CanvasCliConfig,
): Promise<StatusJson> {
  const [healthy, dockerReachable, serviceStatus, cliVersion] = await Promise.all([
    docker.isHealthy(config),
    docker.isReachable().catch(() => false),
    services.status(config).catch(() => 'service: unknown'),
    resolveCliVersion(),
  ]);
  const container = dockerReachable ? await docker.inspectContainer(config).catch(() => null) : null;
  const image = dockerReachable
    ? await docker.imageStatus(config, container?.id || '').catch(() => null)
    : null;
  return {
    healthy,
    serviceActive: serviceStatus.includes(':') ? serviceStatus.slice(serviceStatus.indexOf(':') + 1).trim() : serviceStatus,
    installDir: config.paths.installDir,
    composeFile: config.paths.composeFile,
    dataDir: config.dataDir,
    managerLog: context.paths.logFile,
    image: image || {
      configuredRef: config.image,
      localId: '',
      localDigest: '',
      localCreated: '',
      runningRef: '',
      runningImageId: '',
      runningStartedAt: '',
      appVersion: '',
      cliVersion,
    },
    container,
  };
}

async function diagnosePayload(
  context: RuntimeContext,
  docker: DockerManager,
  services: ServiceManager,
  config: CanvasCliConfig,
) {
  const [status, vm, dockerReachable] = await Promise.all([
    statusJson(context, docker, services, config),
    collectHostResources(config.paths.installDir),
    docker.isReachable().catch(() => false),
  ]);
  return {
    status,
    vm,
    platform: context.platform,
    dockerReachable,
    healthUrl: docker.healthUrl(config),
  };
}

function domainFromBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Base URL must be a valid http:// or https:// URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must be a valid http:// or https:// URL.');
  }
  return url.hostname;
}

function validateDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!domain) return '';
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain)) {
    throw new Error(`Invalid domain: ${value}`);
  }
  return domain;
}

function validateImageReference(value: string): string {
  const image = value.trim();
  if (image.length < 1 || image.length > 512 || !/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/u.test(image)) {
    throw new Error(`Invalid OCI image reference: ${value}`);
  }
  return image;
}

function validateDataDirectory(config: CanvasCliConfig, value: string): string {
  const dataDirectory = value.trim();
  const absolute = config.platform.os === 'windows'
    ? path.win32.isAbsolute(dataDirectory)
    : path.posix.isAbsolute(dataDirectory);
  if (!absolute || /[\0\r\n]/u.test(dataDirectory)) {
    throw new Error('dataDir must be an absolute path without control characters.');
  }
  return dataDirectory;
}

function setConfigValue(config: CanvasCliConfig, key: string, value: string): CanvasCliConfig {
  const next = structuredClone(config);
  if (key === 'hostPort' || key === 'containerPort') {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
    next[key] = port;
    return next;
  }
  if (key === 'image') {
    next.image = validateImageReference(value);
    return next;
  }
  if (key === 'domain') {
    next.domain = validateDomain(value);
    if (next.domain) {
      next.env.BASE_URL = `https://${next.domain}`;
      next.env.BETTER_AUTH_BASE_URL = `https://${next.domain}`;
    }
    return next;
  }
  if (key === 'dataDir') {
    next.dataDir = validateDataDirectory(config, value);
    next.paths.dataDir = next.dataDir;
    return next;
  }
  if (key === 'swap.enabled') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) next.swap.enabled = true;
    else if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) next.swap.enabled = false;
    else throw new Error('Swap enabled must be true or false.');
    return next;
  }
  if (key === 'swap.size') {
    const match = value.match(/^([0-9]+)([KMGT])$/iu);
    if (!match || match[1].length > 8) {
      throw new Error(`Invalid swap size "${value}". Expected a value between 128M and 16G.`);
    }
    const amount = Number(match[1]);
    const unit = match[2].toUpperCase();
    const sizeInKib = amount * ({ K: 1, M: 1024, G: 1024 * 1024, T: 1024 * 1024 * 1024 }[unit] || 0);
    if (!Number.isSafeInteger(sizeInKib) || sizeInKib < 128 * 1024 || sizeInKib > 16 * 1024 * 1024) {
      throw new Error('Swap size must be between 128M and 16G.');
    }
    next.swap.size = value;
    return next;
  }
  if (key === 'swap.file') {
    const managedSwapFile = process.env.CANVAS_SWAP_TEST_ROOT
      ? path.join(path.resolve(process.env.CANVAS_SWAP_TEST_ROOT), 'swapfile')
      : '/swapfile';
    if (value !== managedSwapFile) {
      throw new Error(`Canvas-managed swap file path must be ${managedSwapFile}.`);
    }
    next.swap.file = value;
    return next;
  }
  if (key === 'swap.swappiness') {
    const swappiness = Number(value);
    if (!/^\d+$/u.test(value) || !Number.isInteger(swappiness) || swappiness < 0 || swappiness > 200) {
      throw new Error('Swap swappiness must be an integer between 0 and 200.');
    }
    next.swap.swappiness = swappiness;
    return next;
  }
  if (key === 'autoUpdate.enabled') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) next.autoUpdate.enabled = true;
    else if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) next.autoUpdate.enabled = false;
    else throw new Error('Auto-update enabled must be true or false.');
    return next;
  }
  if (key === 'autoUpdate.schedule') {
    if (!/^[*0-9]{1,2}-[*0-9]{1,2}-[*0-9]{1,2} [*0-9:,]+$/u.test(value)) {
      throw new Error(`Invalid systemd schedule format "${value}". Example: "*-*-* 04:00:00".`);
    }
    next.autoUpdate.schedule = value;
    return next;
  }
  if (key.startsWith('env.')) {
    const envKey = key.slice(4);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envKey)) throw new Error(`Invalid environment key: ${envKey || '(empty)'}`);
    if (envKey === 'BOOTSTRAP_ADMIN_PASSWORD') {
      throw new Error('BOOTSTRAP_ADMIN_PASSWORD is not stored in config.json. Use admin reset-password --password-stdin.');
    }
    if (envKey === 'BETTER_AUTH_BASE_URL' && value) {
      next.domain = domainFromBaseUrl(value);
      next.env.BETTER_AUTH_BASE_URL = value;
      next.env.BASE_URL = value;
      return next;
    }
    if (envKey === 'BASE_URL' && value) {
      next.domain = domainFromBaseUrl(value);
      next.env.BASE_URL = value;
      if (!String(next.env.BETTER_AUTH_BASE_URL || '').trim()) next.env.BETTER_AUTH_BASE_URL = value;
      return next;
    }
    if (envKey === 'CANVAS_DATABASE_PROVIDER') {
      next.env[envKey] = parseCliDatabaseProvider(value);
      return next;
    }
    if (envKey === 'CANVAS_DEPLOYMENT_MODE') {
      next.env[envKey] = value.trim().toLowerCase();
      return next;
    }
    if (envKey === 'DATABASE_URL' && value && !/^postgres(?:ql)?:\/\//u.test(value)) {
      throw new Error('DATABASE_URL must use postgres:// or postgresql://');
    }
    next.env[envKey] = isSensitiveEnvKey(envKey)
      ? value
      : value === 'true' ? true : value === 'false' ? false : value;
    return next;
  }
  throw new Error(`Unsupported config key: ${key}`);
}

async function readSingleLineStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  const value = Buffer.concat(chunks).toString('utf8');
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('config-set --stdin accepts a single-line value.');
  }
  return value;
}

function printSwapStatus(status: SwapStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status));
    return;
  }
  console.log(`Canvas swap enabled setting: ${status.enabled}`);
  console.log(`Canvas swap file: ${status.file}`);
  console.log(`Canvas swap size: ${status.configuredSize}`);
  console.log(`Canvas swap swappiness: ${status.configuredSwappiness}`);
  console.log(`Canvas swap active: ${status.active}`);
  console.log(`Canvas swap persistent: ${status.persistent}`);
  console.log(`Canvas swap in sync: ${status.inSync}`);
  if (status.error) console.error(`Canvas swap error: ${status.error}`);
}

function printCaddyStatus(status: CaddyStatus, json: boolean, content: string | null = null): void {
  if (json) {
    console.log(JSON.stringify(status));
    return;
  }
  console.log(`Configured base URL: ${status.configuredBaseUrl || '(not set)'}`);
  console.log(`Caddy domain: ${status.domain || '(not set)'}`);
  console.log(`Public domain: ${status.publicDomain}`);
  console.log(`Caddy installed: ${status.installed}`);
  console.log(`Caddy service active: ${status.serviceActive}`);
  console.log(`Caddyfile: ${status.caddyfile}`);
  console.log(`Caddyfile managed: ${status.caddyfileManaged}`);
  console.log(`Legacy Canvas config present: ${status.legacyConfigExists}`);
  console.log(`Caddy configuration in sync: ${status.inSync}`);
  if (status.issues.length > 0) console.log(`Caddy issues: ${status.issues.join(', ')}`);
  if (status.error) console.error(`Caddy error: ${status.error}`);
  if (content !== null) {
    console.log('');
    console.log(content.trimEnd());
  }
}

function printAutoUpdateStatus(status: AutoUpdateStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status));
    return;
  }
  console.log(`Auto-update enabled setting: ${status.configuredEnabled}`);
  console.log(`Auto-update schedule: ${status.configuredSchedule}`);
  console.log(`Managed by Control Plane: ${status.managedByControlPlane}`);
  console.log(`Configured image pinned: ${status.imagePinned}`);
  console.log(`Timer unit installed: ${status.timerUnitInstalled}`);
  console.log(`Service unit installed: ${status.serviceUnitInstalled}`);
  console.log(`Timer active: ${status.timerActive}`);
  console.log(`Update service state: ${status.serviceState}`);
  console.log(`Next scheduled run: ${status.nextRun || '(not scheduled)'}`);
  console.log(`Auto-update in sync: ${status.inSync}`);
  if (status.issues.length > 0) console.log(`Auto-update issues: ${status.issues.join(', ')}`);
  if (status.error) console.error(`Auto-update error: ${status.error}`);
}

async function runAutoUpdateCommand(
  command: string,
  args: string[],
  json: boolean,
  context: RuntimeContext,
  runner: SpawnCommandRunner,
  currentConfig: CanvasCliConfig,
): Promise<void> {
  const autoUpdate = new AutoUpdateManager(runner, context);
  if (args.includes('-h') || args.includes('--help')) {
    if (args.length !== 1) throw new Error(`Usage: canvas-notebook ${command} [--json]`);
    console.log(command === 'auto-update-enable'
      ? 'Usage: canvas-notebook auto-update-enable [--schedule <calendar>] [--json]'
      : `Usage: canvas-notebook ${command} [--json]`);
    return;
  }
  const next = structuredClone(currentConfig);
  if (command === 'auto-update-enable') {
    let scheduleSet = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg !== '--schedule' && !arg.startsWith('--schedule=')) throw new Error(`Unknown auto-update-enable option: ${arg}`);
      if (scheduleSet) throw new Error('--schedule can only be provided once.');
      const parsed = readOptionValue(args, index, '--schedule');
      next.autoUpdate.schedule = validateAutoUpdateSchedule(parsed.value);
      scheduleSet = true;
      index = parsed.nextIndex;
    }
    next.autoUpdate.enabled = true;
  } else if (args.length > 0) {
    throw new Error(`Usage: canvas-notebook ${command} [--json]`);
  }
  if (command === 'auto-update-disable') next.autoUpdate.enabled = false;
  try {
    if (command === 'auto-update-status') {
      printAutoUpdateStatus(await autoUpdate.status(currentConfig), json);
      return;
    }
    const action = command === 'auto-update-enable' ? 'enable' : command === 'auto-update-disable' ? 'disable' : 'sync';
    const result = await autoUpdate.apply(next, action);
    next.autoUpdate.enabled = result.effectiveEnabled;
    try {
      await writeConfig(next);
    } catch (error) {
      await autoUpdate.apply(currentConfig, 'sync').catch(() => undefined);
      throw error;
    }
    await appendLog(context, command);
    printAutoUpdateStatus(result, json);
  } catch (error) {
    const latestConfig = await readConfig(context).catch(() => currentConfig);
    const detail = error instanceof Error ? error.message : 'Auto-update operation failed.';
    printAutoUpdateStatus(await autoUpdate.status(latestConfig, detail), json);
    process.exitCode = 1;
  }
}

async function runCaddyCommand(
  command: string,
  args: string[],
  json: boolean,
  context: RuntimeContext,
  runner: SpawnCommandRunner,
  config: CanvasCliConfig,
): Promise<void> {
  const caddy = new CaddyManager(runner, context);
  if (args.includes('-h') || args.includes('--help')) {
    if (args.length !== 1) throw new Error(`Usage: canvas-notebook ${command} [--json]`);
    console.log(`Usage: canvas-notebook ${command} [--json]`);
    return;
  }
  if (args.length > 0) throw new Error(`Usage: canvas-notebook ${command} [--json]`);
  try {
    if (command === 'caddy') {
      const [status, content] = await Promise.all([
        caddy.status(config),
        json ? Promise.resolve(null) : caddy.displayContent(),
      ]);
      printCaddyStatus(status, json, content);
      return;
    }
    await appendLog(context, command);
    printCaddyStatus(await caddy.apply(config, { repair: command === 'caddy-fix' }), json);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Caddy operation failed.';
    printCaddyStatus(await caddy.status(config, errorMessage), json);
    process.exitCode = 1;
  }
}

function swapConfigFromCommand(
  command: string,
  args: string[],
  config: CanvasCliConfig,
  managedFile: string,
): { config: CanvasCliConfig; secure: boolean; showHelp: boolean } {
  if (args.includes('-h') || args.includes('--help')) {
    return { config, secure: false, showHelp: true };
  }
  const next = structuredClone(config);
  let secure = false;
  const supplied = new Set<string>();
  if (command === 'swap' || command === 'swap-sync') {
    if (args.length > 0) throw new Error(`Usage: canvas-notebook ${command} [--json]`);
    return { config: next, secure, showHelp: false };
  }
  if (command === 'swap-disable') {
    for (const arg of args) {
      if (arg === '--secure' && !secure) secure = true;
      else throw new Error('Usage: canvas-notebook swap-disable [--secure] [--json]');
    }
    next.swap.enabled = false;
    validateSwapConfig(next, managedFile);
    return { config: next, secure, showHelp: false };
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const option = ['--enabled', '--size', '--file', '--swappiness']
      .find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
    if (!option) throw new Error(`Unknown ${command} option: ${arg}`);
    if (supplied.has(option)) throw new Error(`${option} can only be provided once.`);
    supplied.add(option);
    const parsed = readOptionValue(args, i, option);
    i = parsed.nextIndex;
    if (option === '--enabled') {
      const normalized = parsed.value.trim().toLowerCase();
      if (normalized !== 'true' && normalized !== 'false') throw new Error('--enabled must be true or false.');
      next.swap.enabled = normalized === 'true';
    } else if (option === '--size') next.swap.size = parsed.value.toUpperCase();
    else if (option === '--file') next.swap.file = parsed.value;
    else next.swap.swappiness = Number(parsed.value);
  }
  if (command === 'swap-apply') {
    for (const required of ['--enabled', '--size', '--file', '--swappiness']) {
      if (!supplied.has(required)) {
        throw new Error('swap-apply requires --enabled, --size, --file, and --swappiness.');
      }
    }
  } else if (command === 'swap-enable') {
    if (supplied.has('--enabled')) throw new Error('swap-enable does not accept --enabled.');
    next.swap.enabled = true;
  } else {
    throw new Error(`Unknown swap command: ${command}`);
  }
  validateSwapConfig(next, managedFile);
  return { config: next, secure, showHelp: false };
}

async function runSwapCommand(
  command: string,
  args: string[],
  json: boolean,
  context: RuntimeContext,
  runner: SpawnCommandRunner,
  currentConfig: CanvasCliConfig,
): Promise<void> {
  const swap = new SwapManager(runner, context);
  let statusConfig = currentConfig;
  try {
    const parsed = swapConfigFromCommand(command, args, currentConfig, swap.managedFile());
    if (parsed.showHelp) {
      console.log('Usage: canvas-notebook swap|swap-sync|swap-apply|swap-enable|swap-disable [options]');
      return;
    }
    if (command === 'swap') {
      printSwapStatus(await swap.status(currentConfig), json);
      return;
    }
    if (parsed.secure) await swap.journalSecureIntent(parsed.config.swap.file);
    if (command !== 'swap-sync') {
      await writeConfig(parsed.config);
      statusConfig = parsed.config;
    }
    await appendLog(context, `${command}${parsed.secure ? ' --secure' : ''}`);
    printSwapStatus(await swap.reconcile(parsed.config, parsed.secure), json);
  } catch (error) {
    statusConfig = await readConfig(context).catch(() => statusConfig);
    const message = error instanceof Error ? error.message : 'Swap reconciliation failed';
    printSwapStatus(await swap.status(statusConfig, message), json);
    process.exitCode = 1;
  }
}

function databaseStatusPayload(config: CanvasCliConfig) {
  const provider = String(config.env.CANVAS_DATABASE_PROVIDER || 'sqlite');
  const postgresMode = provider === 'postgres' ? String(config.env.CANVAS_POSTGRES_MODE || 'managed') : null;
  const deploymentMode = String(config.env.CANVAS_DEPLOYMENT_MODE || 'single_user');
  const postgresRequired = ['true', '1', 'yes', 'on'].includes(String(config.env.CANVAS_POSTGRES_REQUIRED || '').trim().toLowerCase());
  return {
    databaseProvider: provider,
    postgresMode,
    deploymentMode,
    postgresRequired,
    postgresProfileEnabled: provider === 'postgres' && postgresMode === 'managed',
    postgres: {
      image: String(config.env.CANVAS_POSTGRES_IMAGE || ''),
      dataVolume: String(config.env.CANVAS_POSTGRES_DATA_VOLUME || ''),
      database: String(config.env.CANVAS_POSTGRES_DB || ''),
      user: String(config.env.CANVAS_POSTGRES_USER || ''),
      databaseUrlConfigured: Boolean(String(config.env.DATABASE_URL || '').trim()),
      pgvectorEnabled: String(config.env.CANVAS_POSTGRES_VECTOR_ENABLED || '').trim().toLowerCase() === 'true',
    },
  };
}

function printDatabaseStatus(config: CanvasCliConfig, json: boolean): void {
  const status = databaseStatusPayload(config);
  if (json) {
    console.log(JSON.stringify(status));
    return;
  }
  console.log(`Database provider: ${status.databaseProvider}`);
  console.log(`Postgres mode: ${status.postgresMode || '(not applicable)'}`);
  console.log(`Deployment mode: ${status.deploymentMode}`);
  console.log(`Postgres required: ${status.postgresRequired ? 'yes' : 'no'}`);
  console.log(`Postgres profile: ${status.postgresProfileEnabled ? 'enabled' : 'disabled'}`);
  console.log(`Postgres image: ${status.postgres.image || '(not set)'}`);
  console.log(`Postgres volume: ${status.postgres.dataVolume || '(not set)'}`);
  console.log(`DATABASE_URL: ${status.postgres.databaseUrlConfigured ? 'configured' : '(not set)'}`);
}

function parsePostgresReconcileTimeout(args: string[]): number {
  let timeoutSeconds = Number(process.env.CANVAS_POSTGRES_RECONCILE_TIMEOUT || 900);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const parsed = readOptionValue(args, i, '--timeout');
      timeoutSeconds = Number(parsed.value);
      i = parsed.nextIndex;
    } else {
      throw new Error(`Unknown reconcile-postgres-auth option: ${arg}`);
    }
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) {
    throw new Error('--timeout must be an integer from 1 to 7200 seconds.');
  }
  return timeoutSeconds;
}

function envFileValue(content: string, key: string): string {
  const prefix = `${key}=`;
  const line = content.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length) : '';
}

function rollbackPostgresConfig(
  desiredConfig: CanvasCliConfig,
  oldUser: string,
  oldDatabase: string,
  oldPassword: string,
  oldDatabaseUrl: string,
): CanvasCliConfig {
  const rollback = structuredClone(desiredConfig);
  rollback.env.CANVAS_POSTGRES_USER = oldUser;
  rollback.env.CANVAS_POSTGRES_DB = oldDatabase;
  rollback.env.CANVAS_POSTGRES_PASSWORD = oldPassword;
  rollback.env.DATABASE_URL = oldDatabaseUrl || `postgresql://${encodeURIComponent(oldUser)}:${encodeURIComponent(oldPassword)}@postgres:5432/${encodeURIComponent(oldDatabase)}`;
  return rollback;
}

async function reconcilePostgresAuth(
  context: RuntimeContext,
  docker: DockerManager,
  config: CanvasCliConfig,
  args: string[],
  json: boolean,
  quiet = false,
): Promise<boolean> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log('Usage: canvas-notebook database reconcile-postgres-auth [--timeout <seconds>] [--json]');
    return true;
  }
  let phase = 'arguments';
  let rollbackConfig: CanvasCliConfig | null = null;
  let oldContainerEnv = '';
  let oldComposeEnv = '';
  let roleMutationStarted = false;
  let timeoutSeconds = 900;
  let deadline = monotonicDeadlineMs(timeoutSeconds);
  let forwardDeadline = deadline;
  let recoveryJournal: PostgresRecoveryJournal | null = null;
  let recoverySnapshot: PostgresRecoverySnapshot | null = null;
  let journalArmed = false;
  let journalWasPending = false;
  let freshInitialization = false;
  const remainingSeconds = (target: number): number => remainingMonotonicSeconds(target);
  try {
    timeoutSeconds = parsePostgresReconcileTimeout(args);
    const rollbackReserve = timeoutSeconds > 1 ? Math.min(30, Math.max(1, Math.floor(timeoutSeconds / 5))) : 0;
    deadline = monotonicDeadlineMs(timeoutSeconds);
    forwardDeadline = deadline - rollbackReserve * 1000;
    phase = 'preflight';
    if (!postgresRuntimeDesired(config)) throw new Error('Managed Postgres is not enabled for this installation.');
    recoveryJournal = await readPostgresRecoveryJournal(config);
    journalWasPending = recoveryJournal !== null;
    if (recoveryJournal) {
      await assertPostgresRecoveryCompatible(config, recoveryJournal);
      recoverySnapshot = await readPostgresRecoverySnapshot(config, recoveryJournal);
      rollbackConfig = recoverySnapshot.rollbackConfig;
      oldContainerEnv = recoverySnapshot.containerEnv;
      oldComposeEnv = recoverySnapshot.composeEnv;
      if (recoveryJournal.state === 'rollback') {
        phase = 'recovery_rollback';
        await restorePostgresRecoverySnapshot(recoverySnapshot);
        await writeComposeFile(rollbackConfig, context.platform);
        const rollbackTimeout = remainingSeconds(deadline);
        if (rollbackTimeout < 1) throw new Error('Recovery deadline exhausted before Postgres rollback.');
        await preparePostgresManagedRuntime({
          docker,
          config: rollbackConfig,
          stdio: json ? 'pipe' : 'inherit',
          ensurePgvector: false,
          reconcileAuth: true,
          timeoutSeconds: rollbackTimeout,
          onPhase: (nextPhase) => {
            phase = `recovery_${nextPhase}`;
            if (nextPhase === 'alter_role') roleMutationStarted = true;
          },
        });
        phase = 'recovery_app';
        await docker.composeOrThrow(rollbackConfig, ['up', '-d', '--no-deps', context.serviceName], json ? 'pipe' : 'inherit');
        phase = 'recovery_health';
        const rollbackHealthTimeout = remainingSeconds(deadline);
        if (rollbackHealthTimeout < 1) throw new Error('Recovery deadline exhausted before app health verification.');
        await docker.waitUntilHealthy(rollbackConfig, rollbackHealthTimeout, rollbackHealthTimeout * 1000);
        await clearPostgresRecoveryJournal(config);
        journalArmed = false;
        const result = { success: true, recovered: 'rollback', healthy: true, rolledBack: true };
        if (!quiet) console.log(json ? JSON.stringify(result) : 'Interrupted Postgres rollback recovered and verified.');
        return true;
      }
    } else {
      await clearPostgresRecoveryJournal(config);
      [oldContainerEnv, oldComposeEnv] = await Promise.all([
        fs.readFile(config.paths.containerEnvFile, 'utf8'),
        fs.readFile(config.paths.composeEnvFile, 'utf8'),
      ]);
    }
    const oldUser = envFileValue(oldComposeEnv, 'CANVAS_POSTGRES_USER');
    const oldDatabase = envFileValue(oldComposeEnv, 'CANVAS_POSTGRES_DB');
    const oldPassword = envFileValue(oldComposeEnv, 'CANVAS_POSTGRES_PASSWORD');
    const oldDatabaseUrl = envFileValue(oldContainerEnv, 'DATABASE_URL');
    const desiredUser = String(config.env.CANVAS_POSTGRES_USER || 'canvas');
    const desiredDatabase = String(config.env.CANVAS_POSTGRES_DB || 'canvas_notebook');
    if (!oldUser || !oldDatabase || oldPassword.length < 8 || oldPassword.includes('***')) {
      if (journalWasPending || await postgresRuntimeInitialized(docker, config)) {
        throw new Error('Existing Postgres credentials are unavailable for safe rollback.');
      }
      freshInitialization = true;
    } else {
      if (oldUser !== desiredUser || oldDatabase !== desiredDatabase) {
        throw new Error('CANVAS_POSTGRES_USER and CANVAS_POSTGRES_DB cannot be changed after initialization.');
      }
      rollbackConfig ??= rollbackPostgresConfig(config, oldUser, oldDatabase, oldPassword, oldDatabaseUrl);
      recoverySnapshot ??= { rollbackConfig, containerEnv: oldContainerEnv, composeEnv: oldComposeEnv };
    }
    phase = 'compose';
    await writeComposeFile(config, context.platform);
    if (freshInitialization) {
      await renderEnvFiles(context, config);
    }
    if (!freshInitialization) {
      if (!rollbackConfig || !recoverySnapshot) {
        throw new Error('Postgres rollback recovery state is unavailable.');
      }
      if (!journalWasPending) {
        await createPostgresRecoverySnapshot(config, recoverySnapshot);
      }
      recoveryJournal = await writePostgresRecoveryJournal(config, rollbackConfig, 'forward', recoveryJournal);
      journalArmed = true;
    }
    const postgresTimeout = remainingSeconds(forwardDeadline);
    if (postgresTimeout < 1) throw new Error('Forward deadline exhausted before Postgres readiness.');
    await preparePostgresManagedRuntime({
      docker,
      config,
      stdio: json ? 'pipe' : 'inherit',
      timeoutSeconds: postgresTimeout,
      reconcileAuth: !freshInitialization,
      onPhase: (nextPhase) => {
        phase = nextPhase;
        if (nextPhase === 'alter_role') roleMutationStarted = true;
      },
    });
    phase = 'render';
    const beforeContainer = await docker.containerId(config);
    const beforeRunning = await docker.isContainerRunning(beforeContainer);
    const rendered = await renderEnvFiles(context, config);
    phase = 'app';
    await docker.composeOrThrow(rendered.config, ['up', '-d', '--no-deps', context.serviceName], json ? 'pipe' : 'inherit');
    const afterContainer = await docker.containerId(rendered.config);
    phase = 'health';
    const healthTimeout = remainingSeconds(forwardDeadline);
    if (healthTimeout < 1) throw new Error('Forward deadline exhausted before health verification.');
    await docker.waitUntilHealthy(rendered.config, healthTimeout, healthTimeout * 1000);
    if (!freshInitialization) await clearPostgresRecoveryJournal(config);
    journalArmed = false;
    const result = {
      success: true,
      databaseProvider: String(config.env.CANVAS_DATABASE_PROVIDER || 'sqlite'),
      postgresStarted: true,
      roleAuthSynchronized: true,
      authVerified: true,
      envRendered: true,
      appRestarted: !beforeRunning || beforeContainer !== afterContainer,
      healthy: true,
    };
    if (!quiet) console.log(json ? JSON.stringify(result) : 'Postgres credentials reconciled, verified, and applied.');
    return true;
  } catch (error) {
    let rolledBack = false;
    if (roleMutationStarted && rollbackConfig) {
      try {
        recoveryJournal = await writePostgresRecoveryJournal(config, rollbackConfig, 'rollback', recoveryJournal);
        if (!recoverySnapshot) throw new Error('Postgres rollback recovery state is unavailable.');
        await restorePostgresRecoverySnapshot(recoverySnapshot);
        const rollbackPostgresTimeout = remainingSeconds(deadline);
        if (rollbackPostgresTimeout < 1) throw new Error('Rollback deadline exhausted before Postgres restoration.');
        await preparePostgresManagedRuntime({
          docker,
          config: rollbackConfig,
          stdio: 'pipe',
          ensurePgvector: false,
          reconcileAuth: true,
          timeoutSeconds: rollbackPostgresTimeout,
        });
        await docker.composeOrThrow(rollbackConfig, ['up', '-d', '--no-deps', context.serviceName], 'pipe');
        const rollbackHealthTimeout = remainingSeconds(deadline);
        if (rollbackHealthTimeout < 1) throw new Error('Rollback deadline exhausted before health verification.');
        await docker.waitUntilHealthy(rollbackConfig, rollbackHealthTimeout, rollbackHealthTimeout * 1000);
        await clearPostgresRecoveryJournal(config);
        journalArmed = false;
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    } else if (journalArmed && !journalWasPending) {
      await clearPostgresRecoveryJournal(config).catch(() => undefined);
      journalArmed = false;
    }
    const genericErrors: Record<string, string> = {
      compose: 'Compose configuration failed.',
      postgres_start: 'Postgres service could not be started without recreation.',
      postgres_ready: 'Postgres did not become ready within the configured timeout.',
      alter_role: 'Postgres role password reconciliation failed.',
      verify: 'Postgres TCP login verification failed.',
      pgvector: 'Postgres extension verification failed.',
      render: 'Environment render failed after Postgres verification.',
      app: 'Canvas Notebook apply failed after Postgres verification.',
      health: 'Canvas Notebook did not become healthy within the configured timeout.',
    };
    const message = phase === 'arguments' || phase === 'preflight'
      ? (error instanceof Error ? error.message : 'Postgres reconciliation preflight failed.')
      : (genericErrors[phase] || 'Postgres credential reconciliation failed.');
    if (quiet) throw new Error(message);
    if (json) {
      console.log(JSON.stringify({ success: false, phase, error: message, rolledBack }));
      process.exitCode = 1;
      return false;
    }
    throw new Error(message);
  }
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

async function database(context: RuntimeContext, docker: DockerManager, config: CanvasCliConfig, args: string[], json: boolean): Promise<void> {
  const subcommand = args.shift();
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    console.log('Usage: canvas-notebook database status|validate|prepare-postgres|reconcile-postgres-auth|migrate-sqlite-to-postgres [options]');
    return;
  }

  if (subcommand === 'status') {
    printDatabaseStatus(config, json);
    return;
  }

  if (subcommand === 'validate') {
    if (!externalPostgresRuntimeDesired(config)) {
      throw new Error('database validate is for CANVAS_POSTGRES_MODE=external; managed Postgres is verified during prepare/start.');
    }
    const result = await preflightExternalPostgres({ config, docker, pgvectorPolicy: 'optional' });
    const payload = { success: true, postgresMode: 'external', ...result };
    if (json) console.log(JSON.stringify(payload));
    else {
      console.log(`External Postgres ${result.serverVersion} is writable.`);
      console.log(`pgvector: ${result.pgvectorAvailable ? result.pgvectorVersion || 'available' : 'unavailable'}`);
    }
    return;
  }

  if (subcommand === 'prepare-postgres') {
    if (args.includes('-h') || args.includes('--help')) {
      console.log('Usage: canvas-notebook database prepare-postgres [--timeout <seconds>] [--json]');
      return;
    }
    if (await hasPostgresRecoveryJournal(config)) {
      throw new Error('An interrupted Postgres auth reconciliation is pending. Run database reconcile-postgres-auth first.');
    }
    if (externalPostgresRuntimeDesired(config)) {
      throw new Error('External Postgres is provider-managed and cannot be prepared by Canvas.');
    }
    const timeoutSeconds = parsePostgresReconcileTimeout(args);
    const existingEnvFiles = await Promise.all([
      fs.readFile(config.paths.containerEnvFile, 'utf8').catch(() => null),
      fs.readFile(config.paths.composeEnvFile, 'utf8').catch(() => null),
    ]);
    if (existingEnvFiles.every((content) => content !== null) && postgresRuntimeDesired(config)) {
      config = ensurePostgresInfrastructureConfig(config, { allowSecretGeneration: false });
      await writeConfig(config);
      await reconcilePostgresAuth(context, docker, config, ['--timeout', String(timeoutSeconds)], json, true);
      config = await readConfig(context);
    }
    let next!: CanvasCliConfig;
    let prepare!: Awaited<ReturnType<typeof preparePostgresManagedRuntime>>;
    try {
      next = await syncFiles(context, config, { postgresInfrastructureOnly: true });
      prepare = await preparePostgresManagedRuntime({ docker, config: next, stdio: json ? 'pipe' : 'inherit', timeoutSeconds });
    } catch (error) {
      if (existingEnvFiles[0] !== null && existingEnvFiles[1] !== null) {
        await Promise.all([
          writeSecureFile(config.paths.containerEnvFile, existingEnvFiles[0]),
          writeSecureFile(config.paths.composeEnvFile, existingEnvFiles[1]),
        ]).catch(() => undefined);
      }
      throw error;
    }
    if (json) {
      console.log(JSON.stringify({ success: true, prepare, ...databaseStatusPayload(next) }));
    } else {
      console.log('Postgres service prepared. No SQLite data was migrated.');
    }
    return;
  }

  if (subcommand === 'reconcile-postgres-auth') {
    await reconcilePostgresAuth(context, docker, config, args, json);
    return;
  }

  if (subcommand !== 'migrate-sqlite-to-postgres') {
    throw new Error(`Unknown database subcommand: ${subcommand}`);
  }
  if (postgresRuntimeDesired(config)) {
    const existingEnvFiles = await Promise.all([
      fs.access(config.paths.containerEnvFile).then(() => true, () => false),
      fs.access(config.paths.composeEnvFile).then(() => true, () => false),
    ]);
    if (existingEnvFiles.every(Boolean)) {
      await reconcilePostgresAuth(context, docker, config, [], json, true);
      config = await readConfig(context);
    }
  }
  const next = externalPostgresRuntimeDesired(config)
    ? await syncFiles(context, config)
    : await syncFiles(context, config, { postgresInfrastructureOnly: true });
  await preparePostgresManagedRuntime({ docker, config: next, stdio: json ? 'pipe' : 'inherit' });
  const containerId = await docker.containerId(next);
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

async function backup(context: RuntimeContext, docker: DockerManager, config: CanvasCliConfig, args: string[], json: boolean): Promise<void> {
  const subcommand = args.shift();
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    throw new Error('Usage: canvas-notebook backup create [--output <path>] [--json] [--no-wait]');
  }
  if (subcommand !== 'create') {
    throw new Error(`Unknown backup subcommand: ${subcommand}`);
  }

  const options = parseBackupCreateOptions(args);
  if (postgresRuntimeDesired(config)) {
    const existingEnvFiles = await Promise.all([
      fs.access(config.paths.containerEnvFile).then(() => true, () => false),
      fs.access(config.paths.composeEnvFile).then(() => true, () => false),
    ]);
    if (existingEnvFiles.every(Boolean)) {
      await reconcilePostgresAuth(context, docker, config, [], json, true);
      config = await readConfig(context);
    }
  }
  const next = await syncFiles(context, config);
  await appendLog(context, 'backup create');
  await preparePostgresManagedRuntime({ docker, config: next, stdio: json ? 'pipe' : 'inherit' });
  const containerId = await docker.containerId(next);
  if (!containerId) throw new Error('Canvas Notebook container is not running. Start it first: canvas-notebook start');

  const scriptArgs = [
    'exec',
    containerId,
    'npx',
    'tsx',
    '--conditions',
    'react-server',
    'scripts/create-full-backup.ts',
  ];
  if (!options.noWait) scriptArgs.push('--latest');
  if (options.keepJobArtifacts) scriptArgs.push('--keep-job-artifacts');
  if (options.noWait) scriptArgs.push('--no-wait');
  scriptArgs.push('--json');

  const result = await docker.dockerOrThrow(scriptArgs, { stdio: 'pipe' });
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error(result.stdout.trim() || 'Backup command did not return JSON.');
  }

  const latestHostPath = path.join(next.dataDir, 'system', 'backups', 'latest', LATEST_BACKUP_FILE_NAME);
  let outputPath: string | null = null;
  if (options.output) {
    outputPath = await copyFileAtomically(latestHostPath, options.output);
  }

  if (json) {
    console.log(JSON.stringify({
      ...payload,
      latestHostPath: options.noWait ? null : latestHostPath,
      outputPath,
    }));
  } else if (options.noWait) {
    const job = payload.job as { id?: string } | undefined;
    console.log(`Full backup queued: ${job?.id || '(unknown job)'}`);
  } else {
    console.log(`Full backup completed: ${outputPath || latestHostPath}`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const context = createRuntimeContext();
  const runner = new SpawnCommandRunner();
  const docker = new DockerManager(runner, context);
  const services = new ServiceManager(runner, context);

  const versionCommand = parsed.versionRequested || parsed.command === 'version';
  if (!parsed.noBanner && parsed.command !== 'help' && !versionCommand) printBanner(context);

  if (versionCommand) {
    await printVersion(context, docker, parsed.json);
    return;
  }

  if (parsed.command === 'help' || parsed.command === '-h' || parsed.command === '--help') {
    printHelp();
    return;
  }

  if (isSwapCommand(parsed.command) && context.platform !== 'linux') {
    const error = 'Swap management is only supported on Linux. No host changes were made.';
    if (parsed.json) console.log(JSON.stringify({ success: false, error }));
    else console.error(error);
    process.exitCode = 1;
    return;
  }

  if (isCaddyCommand(parsed.command) && context.platform !== 'linux') {
    const error = 'Caddy management is only supported on Linux. No host changes were made.';
    if (parsed.json) console.log(JSON.stringify({ success: false, error }));
    else console.error(error);
    process.exitCode = 1;
    return;
  }

  if (isAutoUpdateCommand(parsed.command) && context.platform !== 'linux') {
    const error = 'Auto-update management is only supported on Linux systemd hosts. No host changes were made.';
    if (parsed.json) console.log(JSON.stringify({ success: false, error }));
    else console.error(error);
    process.exitCode = 1;
    return;
  }

  const operationLock = commandRequiresOperationLock(parsed.command, parsed.args)
    ? await acquireOperationLock(context, parsed.command)
    : null;
  try {
    if (parsed.command === 'update') {
      parseUpdateOptions(parsed.args);
      await reexecPortableCliIfUpdated({
        runner,
        context,
        command: 'update',
        args: parsed.args,
        json: parsed.json,
        noBanner: parsed.noBanner,
      });
    }
    const config = await readConfig(context);
    if (await hasPostgresRecoveryJournal(config) && commandRequiresOperationLock(parsed.command, parsed.args) &&
      !commandCanRunWithPendingPostgresRecovery(parsed.command, parsed.args)) {
      throw new Error('An interrupted Postgres auth reconciliation is pending. Run database reconcile-postgres-auth first.');
    }

    switch (parsed.command) {
    case 'install': {
      const options = parseInstallOptions(parsed.args);
      const configExists = await fs.access(context.paths.configFile).then(() => true, () => false);
      if (!configExists && options.database === 'sqlite') {
        throw new Error('Fresh production installations require Postgres. SQLite is supported only for existing installations and migration.');
      }
      if (options.databaseUrlSource) {
        options.database = 'postgres';
        options.postgresMode = 'external';
        const databaseUrl = options.databaseUrlSource.type === 'stdin'
          ? await readSingleLineStdin()
          : (await fs.readFile(options.databaseUrlSource.filePath, 'utf8')).trim();
        if (databaseUrl.length > 16 * 1024) throw new Error('External DATABASE_URL input is too large.');
        config.env.DATABASE_URL = databaseUrl;
      }
      const configured = configureRuntimeAndDatabase(config, options);
      if (externalPostgresRuntimeDesired(configured)) {
        configured.env.CANVAS_POSTGRES_VECTOR_ENABLED = (options.pgvectorPolicy ?? 'required') !== 'disabled';
      } else if (options.pgvectorPolicy && options.pgvectorPolicy !== 'required') {
        throw new Error('--pgvector optional|disabled is only supported with --postgres-mode external.');
      }
      await install(context, docker, configured, { pgvectorPolicy: options.pgvectorPolicy });
      break;
    }
    case 'update':
      await update(context, docker, config, parsed.json, parseUpdateOptions(parsed.args));
      break;
    case 'start': {
      const hasExistingEnv = await Promise.all([
        fs.access(config.paths.containerEnvFile).then(() => true, () => false),
        fs.access(config.paths.composeEnvFile).then(() => true, () => false),
      ]).then((states) => states.every(Boolean));
      if (await hasPostgresRecoveryJournal(config) || (postgresRuntimeDesired(config) && hasExistingEnv)) {
        await reconcilePostgresAuth(context, docker, config, [], parsed.json, true);
      }
      const next = await syncFiles(context, await readConfig(context));
      await appendLog(context, 'start');
      await preparePostgresManagedRuntime({ docker, config: next, stdio: 'inherit' });
      await docker.composeOrThrow(next, ['up', '-d'], 'inherit');
      await docker.waitUntilHealthy(next);
      console.log(`Canvas Notebook is healthy: ${docker.healthUrl(next)}`);
      break;
    }
    case 'restart': {
      const hasExistingEnv = await Promise.all([
        fs.access(config.paths.containerEnvFile).then(() => true, () => false),
        fs.access(config.paths.composeEnvFile).then(() => true, () => false),
      ]).then((states) => states.every(Boolean));
      if (await hasPostgresRecoveryJournal(config) || (postgresRuntimeDesired(config) && hasExistingEnv)) {
        await reconcilePostgresAuth(context, docker, config, [], parsed.json, true);
      }
      const next = await syncFiles(context, await readConfig(context));
      await appendLog(context, 'restart');
      await preparePostgresManagedRuntime({ docker, config: next, stdio: 'inherit' });
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
        console.log(JSON.stringify(await statusJson(context, docker, services, config)));
      } else {
        const status = await statusJson(context, docker, services, config);
        console.log(`Health: ${status.healthy ? 'ok' : 'failed'}`);
        console.log(`Service: ${status.serviceActive}`);
        console.log(`Container: ${status.container?.status || 'not available'}`);
        console.log(`Configured image: ${status.image.configuredRef}`);
      }
      break;
    case 'health': {
      const healthy = await docker.isHealthy(config).catch(() => false);
      if (parsed.json) console.log(JSON.stringify({ healthy }));
      else if (healthy) console.log(`ok ${docker.healthUrl(config)}`);
      if (!healthy) process.exitCode = 1;
      break;
    }
    case 'diagnose': {
      if (parsed.args.length > 0) throw new Error('Usage: canvas-notebook diagnose [--json]');
      const diagnosis = await diagnosePayload(context, docker, services, config);
      if (parsed.json) console.log(JSON.stringify(diagnosis));
      else {
        console.log('== Canvas Notebook ==');
        console.log(`Install dir: ${diagnosis.status.installDir}`);
        console.log(`Compose file: ${diagnosis.status.composeFile}`);
        console.log(`Health URL: ${diagnosis.healthUrl}`);
        console.log(`Health: ${diagnosis.status.healthy ? 'ok' : 'failed'}`);
        console.log(`Docker: ${diagnosis.dockerReachable ? 'reachable' : 'not reachable'}`);
        console.log(`Container: ${diagnosis.status.container?.status || 'not available'}`);
        console.log('');
        console.log('== Host resources ==');
        console.log(`Memory: ${diagnosis.vm.memoryAvailableBytes}/${diagnosis.vm.memoryTotalBytes} bytes available`);
        console.log(`Disk: ${diagnosis.vm.diskAvailableBytes}/${diagnosis.vm.diskTotalBytes} bytes available`);
        console.log(`Uptime: ${Math.floor(diagnosis.vm.uptimeSeconds)} seconds`);
      }
      break;
    }
    case 'logs':
    case 'container-logs':
      await docker.composeOrThrow(config, ['logs', '-f', '--tail=120', context.serviceName], 'inherit');
      break;
    case 'manager-log':
      console.log(await fs.readFile(context.paths.logFile, 'utf8').catch(() => ''));
      break;
    case 'cleanup-logs': {
      if (parsed.args.length > 0) throw new Error('Usage: canvas-notebook cleanup-logs [--json]');
      const pids = await cleanupOrphanedLogFollowers({ runner, context, config });
      if (parsed.json) console.log(JSON.stringify({ success: true, killed: pids.length, pids }));
      else console.log(`Stopped ${pids.length} orphaned compose-log follower${pids.length === 1 ? '' : 's'}.`);
      break;
    }
    case 'swap':
    case 'swap-sync':
    case 'swap-apply':
    case 'swap-enable':
    case 'swap-disable':
      await runSwapCommand(parsed.command, parsed.args, parsed.json, context, runner, config);
      break;
    case 'caddy':
    case 'caddy-reload':
    case 'caddy-fix':
      await runCaddyCommand(parsed.command, parsed.args, parsed.json, context, runner, config);
      break;
    case 'auto-update-status':
    case 'auto-update-enable':
    case 'auto-update-disable':
    case 'auto-update-sync':
      await runAutoUpdateCommand(parsed.command, parsed.args, parsed.json, context, runner, config);
      break;
    case 'env':
      await runEnvCommand(context, runner, docker, config, parsed.args, parsed.json);
      break;
    case 'config-show': {
      const includeSecretState = parsed.args.includes('--secret-state');
      if (parsed.args.some((arg) => arg !== '--secret-state')) throw new Error('Usage: canvas-notebook config-show [--json] [--secret-state]');
      if (includeSecretState && !parsed.json) throw new Error('--secret-state requires --json.');
      const output = includeSecretState
        ? { ...redactConfig(config), secretState: configSecretState(config) }
        : redactConfig(config);
      console.log(JSON.stringify(output, null, 2));
      break;
    }
    case 'config': {
      if (parsed.args.length > 0) throw new Error('Usage: canvas-notebook config [--json]');
      const output = {
        installDir: context.paths.installDir,
        composeFile: context.paths.composeFile,
        dataDir: config.dataDir,
        configFile: context.paths.configFile,
        containerEnv: context.paths.containerEnvFile,
        composeEnv: context.paths.composeEnvFile,
        managerLog: context.paths.logFile,
      };
      if (parsed.json) console.log(JSON.stringify(output));
      else {
        console.log(`Install dir: ${output.installDir}`);
        console.log(`Compose file: ${output.composeFile}`);
        console.log(`Data dir: ${output.dataDir}`);
        console.log(`Config file: ${output.configFile}`);
        console.log(`Container env: ${output.containerEnv}`);
        console.log(`Compose env: ${output.composeEnv}`);
        console.log(`Manager log: ${output.managerLog}`);
      }
      break;
    }
    case 'config-migrate': {
      if (parsed.args.some((arg) => arg !== '--force')) throw new Error('Usage: canvas-notebook config-migrate [--force]');
      const result = await migrateLegacyConfig({
        context,
        currentConfig: config,
        force: parsed.args.includes('--force'),
      });
      if (!result.skipped) await writeConfig(result.config);
      if (parsed.json) console.log(JSON.stringify({
        success: true,
        skipped: result.skipped,
        configFile: result.configFile,
        sources: result.sources,
      }));
      else if (result.skipped) console.log(`config.json already exists at ${result.configFile}; use --force to migrate again.`);
      else console.log(`Migration complete: ${result.configFile}`);
      break;
    }
    case 'config-set': {
      const [key, positionalValue, ...extraArgs] = parsed.args;
      if (!key || positionalValue === undefined) throw new Error('Usage: canvas-notebook config-set <key> <value|--stdin>');
      if (extraArgs.length > 0) {
        throw new Error(positionalValue === '--stdin'
          ? '--stdin is mutually exclusive with a positional value.'
          : 'A positional value cannot be combined with additional options.');
      }
      const value = positionalValue === '--stdin' ? await readSingleLineStdin() : positionalValue;
      if (key.startsWith('env.') && isSensitiveEnvKey(key.slice(4)) && positionalValue !== '--stdin') {
        throw new Error('Sensitive config values require --stdin.');
      }
      const next = setConfigValue(config, key, value);
      await writeConfig(next);
      console.log(positionalValue === '--stdin'
        ? `Set ${key} from stdin in ${next.paths.configFile}`
        : `Set ${key} in ${next.paths.configFile}`);
      break;
    }
    case 'cli-update': {
      const result = await updatePortableCli({ runner, context });
      if (parsed.json) {
        console.log(JSON.stringify(result));
      } else if (result.skipped) {
        console.log('Portable CLI self-update is not available for this local checkout.');
      } else if (result.changed) {
        const versionText = result.beforeVersion || result.afterVersion
          ? ` ${result.beforeVersion || 'unknown'} -> ${result.afterVersion || 'unknown'}`
          : '';
        console.log(`Portable CLI updated${versionText}`);
      } else {
        console.log('Portable CLI is already current.');
      }
      break;
    }
    case 'admin':
      await admin(context, docker, config, parsed.args);
      break;
    case 'backup':
      await backup(context, docker, config, parsed.args, parsed.json);
      break;
    case 'database':
      await database(context, docker, config, parsed.args, parsed.json);
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
  } finally {
    await operationLock?.release();
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error('Canvas Notebook command failed. Check the command arguments and the manager log for details.');
    process.exitCode = 1;
  });
}
