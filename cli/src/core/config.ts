import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { defaultServiceMode } from './platform';
import type { CanvasCliConfig, CliPaths, EnvValue, HostPlatform } from './types';

const DEFAULT_IMAGE = 'ghcr.io/canvascoding/canvas-notebook:latest';

const DEFAULT_ENV: Record<string, EnvValue> = {
  BETTER_AUTH_SECRET: '',
  CANVAS_INTERNAL_API_KEY: '',
  BETTER_AUTH_BASE_URL: '',
  BASE_URL: '',
  PORT: '3000',
  HOSTNAME: '0.0.0.0',
  NODE_ENV: 'production',
  DATA: '/data',
  LOG_LEVEL: 'info',
  ONBOARDING: true,
  ONBOARDING_HINTS: false,
  ALLOW_SIGNUP: false,
  OLLAMA_CLI_AUTO_INSTALL: true,
  CANVAS_DEPLOYMENT_MODE: 'single_user',
  CANVAS_DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: '',
  CANVAS_POSTGRES_VECTOR_ENABLED: false,
  CANVAS_POSTGRES_IMAGE: 'pgvector/pgvector:0.8.3-pg18',
  CANVAS_POSTGRES_DATA_VOLUME: 'canvas-postgres-data',
  CANVAS_POSTGRES_DB: 'canvas_notebook',
  CANVAS_POSTGRES_USER: 'canvas',
  CANVAS_POSTGRES_PASSWORD: '',
};

export function createDefaultConfig(paths: CliPaths, platform: HostPlatform): CanvasCliConfig {
  return {
    domain: '',
    image: DEFAULT_IMAGE,
    hostPort: 3456,
    containerPort: 3000,
    dataDir: paths.dataDir,
    platform: {
      os: platform,
      serviceMode: defaultServiceMode(platform),
    },
    paths,
    swap: {
      enabled: platform === 'linux',
      size: '2G',
      file: '/swapfile',
    },
    autoUpdate: {
      enabled: true,
      schedule: '*-*-* 04:00:00',
    },
    env: { ...DEFAULT_ENV },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) return fallback;
  return numeric;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return !['false', '0', 'no', 'off', 'disabled'].includes(value.trim().toLowerCase());
  }
  return fallback;
}

function asEnvValue(value: unknown): EnvValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeEnv(input: unknown, defaults: Record<string, EnvValue>): Record<string, EnvValue> {
  const env: Record<string, EnvValue> = { ...defaults };
  if (!isRecord(input)) return env;
  for (const [key, value] of Object.entries(input)) {
    env[key] = asEnvValue(value);
  }
  return env;
}

export function normalizeConfig(
  input: unknown,
  defaults: CanvasCliConfig,
): CanvasCliConfig {
  if (!isRecord(input)) return defaults;

  const env = normalizeEnv(input.env, defaults.env);
  const paths = isRecord(input.paths) ? { ...defaults.paths, ...input.paths } : { ...defaults.paths };
  const platform = isRecord(input.platform)
    ? {
      os: input.platform.os === 'linux' || input.platform.os === 'macos' || input.platform.os === 'windows'
        ? input.platform.os
        : defaults.platform.os,
      serviceMode: input.platform.serviceMode === 'systemd'
        || input.platform.serviceMode === 'launchd'
        || input.platform.serviceMode === 'scheduled-task'
        || input.platform.serviceMode === 'none'
        ? input.platform.serviceMode
        : defaults.platform.serviceMode,
    }
    : defaults.platform;

  const dataDir = asString(input.dataDir, paths.dataDir || defaults.dataDir);
  paths.dataDir = dataDir;

  return {
    domain: asString(input.domain, defaults.domain),
    image: asString(input.image, defaults.image),
    hostPort: asNumber(input.hostPort, defaults.hostPort),
    containerPort: asNumber(input.containerPort, defaults.containerPort),
    dataDir,
    platform,
    paths,
    swap: {
      enabled: asBoolean(isRecord(input.swap) ? input.swap.enabled : undefined, defaults.swap.enabled),
      size: asString(isRecord(input.swap) ? input.swap.size : undefined, defaults.swap.size),
      file: asString(isRecord(input.swap) ? input.swap.file : undefined, defaults.swap.file),
    },
    autoUpdate: {
      enabled: asBoolean(isRecord(input.autoUpdate) ? input.autoUpdate.enabled : undefined, defaults.autoUpdate.enabled),
      schedule: asString(isRecord(input.autoUpdate) ? input.autoUpdate.schedule : undefined, defaults.autoUpdate.schedule),
    },
    env,
  };
}

export async function loadConfig(paths: CliPaths, platform: HostPlatform): Promise<CanvasCliConfig> {
  const defaults = createDefaultConfig(paths, platform);
  try {
    const raw = await fs.readFile(paths.configFile, 'utf8');
    return normalizeConfig(JSON.parse(raw), defaults);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults;
    throw error;
  }
}

export async function writeConfig(config: CanvasCliConfig): Promise<void> {
  await fs.mkdir(path.dirname(config.paths.configFile), { recursive: true });
  await fs.writeFile(config.paths.configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function randomSecret(): string {
  return crypto.randomBytes(32).toString('base64');
}

export function ensureSecrets(config: CanvasCliConfig): CanvasCliConfig {
  const next = structuredClone(config);
  if (!String(next.env.BETTER_AUTH_SECRET || '').trim()) {
    next.env.BETTER_AUTH_SECRET = randomSecret();
  }
  if (!String(next.env.CANVAS_INTERNAL_API_KEY || '').trim()) {
    next.env.CANVAS_INTERNAL_API_KEY = randomSecret();
  }
  return next;
}

export function ensureBaseUrl(config: CanvasCliConfig, baseUrl?: string): CanvasCliConfig {
  const next = structuredClone(config);
  const url = baseUrl || String(next.env.BASE_URL || next.env.BETTER_AUTH_BASE_URL || '').trim() || `http://localhost:${next.hostPort}`;
  next.env.BASE_URL = url;
  next.env.BETTER_AUTH_BASE_URL = url;
  try {
    next.domain = new URL(url).hostname;
  } catch {
    next.domain = '';
  }
  return next;
}

export function normalizeDatabaseConfig(config: CanvasCliConfig): CanvasCliConfig {
  const next = structuredClone(config);
  const provider = String(next.env.CANVAS_DATABASE_PROVIDER || 'sqlite').trim().toLowerCase();
  next.env.CANVAS_DATABASE_PROVIDER = provider === 'postgres' ? 'postgres' : 'sqlite';

  if (next.env.CANVAS_DATABASE_PROVIDER !== 'postgres') {
    next.env.CANVAS_POSTGRES_VECTOR_ENABLED = false;
    return next;
  }

  next.env.CANVAS_POSTGRES_VECTOR_ENABLED = true;
  next.env.CANVAS_POSTGRES_IMAGE = next.env.CANVAS_POSTGRES_IMAGE || 'pgvector/pgvector:0.8.3-pg18';
  next.env.CANVAS_POSTGRES_DATA_VOLUME = next.env.CANVAS_POSTGRES_DATA_VOLUME || 'canvas-postgres-data';
  next.env.CANVAS_POSTGRES_DB = next.env.CANVAS_POSTGRES_DB || 'canvas_notebook';
  next.env.CANVAS_POSTGRES_USER = next.env.CANVAS_POSTGRES_USER || 'canvas';
  if (!String(next.env.CANVAS_POSTGRES_PASSWORD || '').trim()) {
    next.env.CANVAS_POSTGRES_PASSWORD = randomSecret().replace(/[+/=]/g, '').slice(0, 32);
  }
  if (!String(next.env.DATABASE_URL || '').trim()) {
    next.env.DATABASE_URL = `postgresql://${next.env.CANVAS_POSTGRES_USER}:${next.env.CANVAS_POSTGRES_PASSWORD}@postgres:5432/${next.env.CANVAS_POSTGRES_DB}`;
  }
  return next;
}

export function materializeConfig(config: CanvasCliConfig, baseUrl?: string): CanvasCliConfig {
  return normalizeDatabaseConfig(ensureBaseUrl(ensureSecrets(config), baseUrl));
}

function envLine(key: string, value: EnvValue): string {
  if (value === undefined || value === null) return `${key}=`;
  return `${key}=${String(value).replace(/\r?\n/g, '')}`;
}

export function containerEnvText(config: CanvasCliConfig): string {
  const entries = Object.entries(config.env).sort(([a], [b]) => a.localeCompare(b));
  return [
    '# Auto-generated from canvas-notebook-config.json. Do not edit manually.',
    '# Run: canvas-notebook env --sync to regenerate.',
    '',
    ...entries.map(([key, value]) => envLine(key, value)),
    '',
  ].join('\n');
}

export function composeEnvText(config: CanvasCliConfig, composeDataDir: string): string {
  const postgresProfile = String(config.env.CANVAS_DATABASE_PROVIDER || 'sqlite') === 'postgres' ? 'postgres' : '';
  const entries: Record<string, EnvValue> = {
    CANVAS_IMAGE: config.image,
    HOST_PORT: config.hostPort,
    CONTAINER_PORT: config.containerPort,
    DATA_DIR: composeDataDir,
    COMPOSE_PROFILES: postgresProfile,
    CANVAS_DATABASE_PROVIDER: config.env.CANVAS_DATABASE_PROVIDER,
    CANVAS_POSTGRES_IMAGE: config.env.CANVAS_POSTGRES_IMAGE || 'pgvector/pgvector:0.8.3-pg18',
    CANVAS_POSTGRES_DATA_VOLUME: config.env.CANVAS_POSTGRES_DATA_VOLUME || 'canvas-postgres-data',
    CANVAS_POSTGRES_DB: config.env.CANVAS_POSTGRES_DB || 'canvas_notebook',
    CANVAS_POSTGRES_USER: config.env.CANVAS_POSTGRES_USER || 'canvas',
    CANVAS_POSTGRES_PASSWORD: config.env.CANVAS_POSTGRES_PASSWORD || '',
  };

  return [
    '# Auto-generated from canvas-notebook-config.json. Do not edit manually.',
    '# Run: canvas-notebook env --sync to regenerate.',
    '',
    ...Object.entries(entries).map(([key, value]) => envLine(key, value)),
    '',
  ].join('\n');
}

export async function writeEnvFiles(config: CanvasCliConfig, composeDataDir: string): Promise<void> {
  await fs.mkdir(path.dirname(config.paths.containerEnvFile), { recursive: true });
  await fs.writeFile(config.paths.containerEnvFile, containerEnvText(config), 'utf8');
  await fs.writeFile(config.paths.composeEnvFile, composeEnvText(config, composeDataDir), 'utf8');
}
