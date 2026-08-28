import { setTimeout as delay } from 'node:timers/promises';

import type { DockerManager } from './docker';
import type { CanvasCliConfig, EnvValue } from './types';

export interface PostgresPrepareResult {
  desired: boolean;
  containerId: string;
  roleAuthSynchronized: boolean;
  authVerified: boolean;
  pgvectorEnsured: boolean;
}

function normalized(value: EnvValue): string {
  return String(value ?? '').trim().toLowerCase();
}

function truthy(value: EnvValue): boolean {
  return ['true', '1', 'yes', 'on'].includes(normalized(value));
}

function runtimeValue(config: CanvasCliConfig, key: string, fallback = ''): string {
  return String(config.env[key] ?? fallback).trim();
}

export function postgresRuntimeDesired(config: CanvasCliConfig): boolean {
  if (truthy(config.env.CANVAS_POSTGRES_REQUIRED) ||
    truthy(config.env.CANVAS_POSTGRES_VECTOR_ENABLED) ||
    truthy(config.env.CANVAS_TEAM_FEATURES_ENABLED)) return true;
  const provider = normalized(config.env.CANVAS_DATABASE_PROVIDER);
  if (provider === 'postgres') return true;
  if (provider === 'sqlite') return false;
  return provider === '' && /^postgres(?:ql)?:\/\//iu.test(runtimeValue(config, 'DATABASE_URL'));
}

function postgresContainerName(config: CanvasCliConfig): string {
  return runtimeValue(config, 'CANVAS_POSTGRES_CONTAINER_NAME', 'canvas-notebook-postgres') || 'canvas-notebook-postgres';
}

function postgresDatabase(config: CanvasCliConfig): string {
  return runtimeValue(config, 'CANVAS_POSTGRES_DB', 'canvas_notebook') || 'canvas_notebook';
}

function postgresUser(config: CanvasCliConfig): string {
  return runtimeValue(config, 'CANVAS_POSTGRES_USER', 'canvas') || 'canvas';
}

function postgresPassword(config: CanvasCliConfig): string {
  return runtimeValue(config, 'CANVAS_POSTGRES_PASSWORD');
}

function isMaskedOrInvalidSecret(value: string): boolean {
  const text = value.trim();
  if (text.length < 8) return true;
  if (text === '(not set)' || text.includes('***')) return true;
  return /^(redacted|masked|filtered)$/iu.test(text);
}

function ensurePostgresSecrets(config: CanvasCliConfig): void {
  const password = postgresPassword(config);
  if (isMaskedOrInvalidSecret(password)) {
    throw new Error('Postgres prepare requires an unredacted CANVAS_POSTGRES_PASSWORD with at least 8 characters.');
  }
  const databaseUrl = runtimeValue(config, 'DATABASE_URL');
  if (databaseUrl === 'postgresql://***' || databaseUrl.includes('***')) {
    throw new Error('Postgres prepare requires an unredacted DATABASE_URL.');
  }
  if (databaseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new Error('DATABASE_URL must include user, password, host, and database for managed Postgres.');
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      throw new Error('DATABASE_URL must use postgres:// or postgresql://');
    }
    const urlUser = decodeURIComponent(parsed.username || '');
    const urlPassword = decodeURIComponent(parsed.password || '');
    const urlDatabase = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/gu, '').split('/')[0] || '');
    if (urlUser !== postgresUser(config) || urlPassword !== password || urlDatabase !== postgresDatabase(config)) {
      throw new Error('DATABASE_URL credentials must match CANVAS_POSTGRES_USER, CANVAS_POSTGRES_PASSWORD, and CANVAS_POSTGRES_DB.');
    }
  }
}

function postgresSqlLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

async function postgresContainerId(docker: DockerManager, config: CanvasCliConfig): Promise<string> {
  const composeResult = await docker.compose(config, ['ps', '-q', 'postgres']);
  const composeId = composeResult.status === 0 ? composeResult.stdout.trim() : '';
  if (composeId) return composeId;

  const name = postgresContainerName(config);
  const inspectResult = await docker.docker(['inspect', '--format', '{{.Id}}', name]);
  return inspectResult.status === 0 ? inspectResult.stdout.trim() : '';
}

export async function postgresRuntimeInitialized(docker: DockerManager, config: CanvasCliConfig): Promise<boolean> {
  if (await postgresContainerId(docker, config)) return true;
  const volume = runtimeValue(config, 'CANVAS_POSTGRES_DATA_VOLUME', 'canvas-postgres-data') || 'canvas-postgres-data';
  const result = await docker.docker(['volume', 'inspect', volume]);
  return result.status === 0;
}

async function inspectContainerStatus(docker: DockerManager, containerIdOrName: string): Promise<string> {
  if (!containerIdOrName) return '';
  const result = await docker.docker(['inspect', '--format', '{{.State.Status}}', containerIdOrName]);
  return result.status === 0 ? result.stdout.trim() : '';
}

async function waitForPostgresRunning(docker: DockerManager, config: CanvasCliConfig, containerId: string, maxAttempts = 60): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await inspectContainerStatus(docker, containerId) === 'running') {
      const ready = await docker.docker([
        'exec',
        '-u',
        'postgres',
        containerId,
        'pg_isready',
        '-U',
        postgresUser(config),
        '-d',
        postgresDatabase(config),
      ]);
      if (ready.status === 0) return;
    }
    await delay(1000);
  }
  throw new Error('Postgres container did not become running after prepare-postgres.');
}

async function syncPostgresRolePassword(docker: DockerManager, config: CanvasCliConfig, containerId: string): Promise<void> {
  const user = postgresUser(config);
  const database = postgresDatabase(config);
  const password = postgresPassword(config);
  const sql = `SELECT format('ALTER ROLE %I PASSWORD %L', ${postgresSqlLiteral(user)}, ${postgresSqlLiteral(password)}) \\gexec\n`;
  await docker.dockerOrThrow([
    'exec',
    '-i',
    '-u',
    'postgres',
    containerId,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    user,
    '-d',
    database,
  ], { stdin: sql, stdio: 'pipe' });
}

function psqlPasswordScript(sqlCommand: string): string {
  return [
    'set -eu',
    'IFS= read -r CANVAS_PG_USER',
    'IFS= read -r CANVAS_PG_DB',
    'IFS= read -r CANVAS_PG_PASSWORD',
    'export PGPASSWORD="$CANVAS_PG_PASSWORD"',
    `exec psql -h 127.0.0.1 -U "$CANVAS_PG_USER" -d "$CANVAS_PG_DB" -v ON_ERROR_STOP=1 ${sqlCommand}`,
  ].join('\n');
}

async function runPasswordVerifiedPsql(docker: DockerManager, config: CanvasCliConfig, containerId: string, sqlArgs: string): Promise<void> {
  await docker.dockerOrThrow([
    'exec',
    '-i',
    containerId,
    'sh',
    '-c',
    psqlPasswordScript(sqlArgs),
  ], {
    stdin: `${postgresUser(config)}\n${postgresDatabase(config)}\n${postgresPassword(config)}\n`,
    stdio: 'pipe',
  });
}

async function verifyRuntimePassword(docker: DockerManager, config: CanvasCliConfig, containerId: string): Promise<void> {
  await runPasswordVerifiedPsql(docker, config, containerId, '-Atc "select 1"');
}

async function ensurePgvector(docker: DockerManager, config: CanvasCliConfig, containerId: string): Promise<void> {
  await runPasswordVerifiedPsql(docker, config, containerId, '-c "CREATE EXTENSION IF NOT EXISTS vector"');
}

export async function preparePostgresManagedRuntime(params: {
  docker: DockerManager;
  config: CanvasCliConfig;
  stdio?: 'pipe' | 'inherit';
  ensurePgvector?: boolean;
  reconcileAuth?: boolean;
  timeoutSeconds?: number;
  onPhase?: (phase: 'postgres_start' | 'postgres_ready' | 'alter_role' | 'verify' | 'pgvector') => void;
}): Promise<PostgresPrepareResult> {
  if (!postgresRuntimeDesired(params.config)) {
    return {
      desired: false,
      containerId: '',
      roleAuthSynchronized: false,
      authVerified: false,
      pgvectorEnsured: false,
    };
  }

  ensurePostgresSecrets(params.config);
  params.onPhase?.('postgres_start');
  await params.docker.composeOrThrow(params.config, ['--profile', 'postgres', 'up', '-d', '--no-recreate', 'postgres'], params.stdio ?? 'pipe');
  const containerId = await postgresContainerId(params.docker, params.config);
  if (!containerId) throw new Error('Postgres container was not found after prepare-postgres.');
  params.onPhase?.('postgres_ready');
  await waitForPostgresRunning(params.docker, params.config, containerId, params.timeoutSeconds ?? 60);
  const reconcileAuth = params.reconcileAuth ?? false;
  if (reconcileAuth) {
    params.onPhase?.('alter_role');
    await syncPostgresRolePassword(params.docker, params.config, containerId);
  }
  params.onPhase?.('verify');
  try {
    await verifyRuntimePassword(params.docker, params.config, containerId);
  } catch (error) {
    if (!reconcileAuth) {
      throw new Error('Postgres credentials do not match the initialized role. Run database reconcile-postgres-auth.');
    }
    throw error;
  }
  const shouldEnsurePgvector = params.ensurePgvector ?? truthy(params.config.env.CANVAS_POSTGRES_VECTOR_ENABLED);
  if (shouldEnsurePgvector) {
    params.onPhase?.('pgvector');
    await ensurePgvector(params.docker, params.config, containerId);
  }

  return {
    desired: true,
    containerId,
    roleAuthSynchronized: reconcileAuth,
    authVerified: true,
    pgvectorEnsured: shouldEnsurePgvector,
  };
}
