import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { defaultServiceMode } from './platform';
import type { CanvasCliConfig, CliPaths, EnvValue, HostPlatform } from './types';

const DEFAULT_IMAGE = 'ghcr.io/canvascoding/canvas-notebook:latest';
const DEFAULT_POSTGRES_IMAGE = 'pgvector/pgvector:0.8.3-pg18';
const DEFAULT_POSTGRES_DATA_VOLUME = 'canvas-postgres-data';
const DEFAULT_POSTGRES_DB = 'canvas_notebook';
const DEFAULT_POSTGRES_USER = 'canvas';
const SECRET_FINGERPRINT_DOMAIN = 'canvas-notebook/secret-state/v1';
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export type CliDatabaseProvider = 'sqlite' | 'postgres';
export type CliPostgresMode = 'managed' | 'external';
export type CliRuntimeMode = 'personal' | 'team';

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
  CANVAS_DATABASE_PROVIDER: 'postgres',
  CANVAS_POSTGRES_MODE: 'managed',
  DATABASE_URL: '',
  CANVAS_POSTGRES_VECTOR_ENABLED: true,
  CANVAS_POSTGRES_IMAGE: DEFAULT_POSTGRES_IMAGE,
  CANVAS_POSTGRES_DATA_VOLUME: DEFAULT_POSTGRES_DATA_VOLUME,
  CANVAS_POSTGRES_DB: DEFAULT_POSTGRES_DB,
  CANVAS_POSTGRES_USER: DEFAULT_POSTGRES_USER,
  CANVAS_POSTGRES_PASSWORD: '',
  CANVAS_STANDALONE_UPDATER_ENABLED: false,
  CANVAS_UPDATER_GID: '',
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
      enabled: false,
      size: '2G',
      file: '/swapfile',
      swappiness: 10,
    },
    autoUpdate: {
      enabled: false,
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

function asIntegerWithin(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) return fallback;
  return numeric;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
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
  if (!isRecord(input)) {
    env.CANVAS_DATABASE_PROVIDER = '';
    env.CANVAS_POSTGRES_MODE = '';
    return env;
  }
  for (const [key, value] of Object.entries(input)) {
    env[key] = asEnvValue(value);
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'CANVAS_DATABASE_PROVIDER')) {
    env.CANVAS_DATABASE_PROVIDER = '';
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'CANVAS_POSTGRES_MODE')) {
    env.CANVAS_POSTGRES_MODE = '';
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
      swappiness: asIntegerWithin(isRecord(input.swap) ? input.swap.swappiness : undefined, defaults.swap.swappiness, 0, 200),
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

export async function writeSecureFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    if (process.platform === 'linux' && typeof process.geteuid === 'function' && process.geteuid() === 0) {
      await fs.chown(tempPath, 0, 0);
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeConfig(config: CanvasCliConfig): Promise<void> {
  await writeSecureFile(config.paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
}

export function randomSecret(): string {
  return crypto.randomBytes(32).toString('base64');
}

export function isPinnedImageReference(value: string): boolean {
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@sha256:[a-f0-9]{64}$/u.test(value);
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

function normalized(value: EnvValue): string {
  return String(value ?? '').trim().toLowerCase();
}

function truthyEnvValue(value: EnvValue): boolean {
  return ['true', '1', 'yes', 'on'].includes(normalized(value));
}

function normalizeDatabaseProviderValue(value: EnvValue): CliDatabaseProvider {
  const provider = normalized(value) || 'sqlite';
  if (provider === 'sqlite' || provider === 'postgres') return provider;
  throw new Error(`Invalid CANVAS_DATABASE_PROVIDER "${provider}". Expected sqlite or postgres.`);
}

function normalizePostgresModeValue(value: EnvValue): CliPostgresMode {
  const mode = normalized(value) || 'managed';
  if (mode === 'managed' || mode === 'external') return mode;
  throw new Error(`Invalid CANVAS_POSTGRES_MODE "${mode}". Expected managed or external.`);
}

function normalizeRuntimeModeValue(value: string): CliRuntimeMode {
  const runtime = value.trim().toLowerCase();
  if (runtime === 'personal' || runtime === 'single-user' || runtime === 'single_user' || runtime === 'managed-single') {
    return 'personal';
  }
  if (runtime === 'team' || runtime === 'managed-team' || runtime === 'enterprise' || runtime === 'enterprise-onprem') {
    return 'team';
  }
  throw new Error(`Invalid runtime "${value}". Expected personal or team.`);
}

function deploymentRequiresPostgres(deploymentMode: EnvValue, teamFeaturesEnabled: EnvValue): boolean {
  const mode = normalized(deploymentMode).replace(/_/gu, '-');
  return mode.includes('team') ||
    mode.includes('enterprise') ||
    mode.includes('advanced') ||
    truthyEnvValue(teamFeaturesEnabled);
}

function requireUrlSafePostgresPart(key: string, value: EnvValue): void {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._~-]+$/.test(text)) {
    throw new Error(`${key} contains URL-reserved characters. Set DATABASE_URL explicitly or use URL-safe Postgres credentials.`);
  }
}

function validateDatabaseUrl(value: EnvValue): void {
  const raw = String(value ?? '').trim();
  if (!raw) return;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
}

function databaseUrlParts(value: EnvValue): { user: string; password: string; database: string } | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  const user = decodeURIComponent(parsed.username || '');
  const encodedPassword = parsed.password || '';
  if (/%(?:00|0a|0d)/iu.test(encodedPassword)) {
    throw new Error('CANVAS_POSTGRES_PASSWORD contains unsafe control characters.');
  }
  const password = decodeURIComponent(encodedPassword);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/u, '').split('/')[0] || '');
  if (!user || !password || !database) {
    throw new Error('DATABASE_URL must include user, password, host, and database for managed Postgres.');
  }
  if (/[\0\r\n]/u.test(password) || password.includes('***') || password === '(not set)') {
    throw new Error('CANVAS_POSTGRES_PASSWORD contains unsafe or masked content.');
  }
  return { user, password, database };
}

export function configureRuntimeAndDatabase(
  config: CanvasCliConfig,
  options: { database?: CliDatabaseProvider; runtime?: CliRuntimeMode; postgresMode?: CliPostgresMode },
): CanvasCliConfig {
  const next = structuredClone(config);
  if (options.runtime) {
    if (options.runtime === 'team') {
      next.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
      next.env.CANVAS_TEAM_FEATURES_ENABLED = true;
      next.env.CANVAS_POSTGRES_REQUIRED = true;
      next.env.CANVAS_DATABASE_PROVIDER = 'postgres';
      next.env.CANVAS_POSTGRES_MODE = options.postgresMode || normalizePostgresModeValue(next.env.CANVAS_POSTGRES_MODE);
    } else {
      next.env.CANVAS_DEPLOYMENT_MODE = 'single_user';
      next.env.CANVAS_TEAM_FEATURES_ENABLED = false;
      next.env.CANVAS_POSTGRES_REQUIRED = false;
    }
  }

  if (options.database) {
    if (options.runtime === 'team' && options.database !== 'postgres') {
      throw new Error('Team runtime requires --database postgres.');
    }
    next.env.CANVAS_DATABASE_PROVIDER = options.database;
    next.env.CANVAS_POSTGRES_MODE = options.database === 'postgres'
      ? options.postgresMode || normalizePostgresModeValue(next.env.CANVAS_POSTGRES_MODE)
      : '';
  } else if (options.postgresMode) {
    next.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    next.env.CANVAS_POSTGRES_MODE = options.postgresMode;
  }

  return next;
}

export function parseCliDatabaseProvider(value: string): CliDatabaseProvider {
  return normalizeDatabaseProviderValue(value);
}

export function parseCliPostgresMode(value: string): CliPostgresMode {
  return normalizePostgresModeValue(value);
}

export function parseCliRuntimeMode(value: string): CliRuntimeMode {
  return normalizeRuntimeModeValue(value);
}

export function ensurePostgresInfrastructureConfig(
  config: CanvasCliConfig,
  options: { allowSecretGeneration?: boolean } = {},
): CanvasCliConfig {
  const next = structuredClone(config);
  const postgresMode = normalizePostgresModeValue(next.env.CANVAS_POSTGRES_MODE);
  if (postgresMode !== 'managed') {
    throw new Error('Managed Postgres infrastructure cannot be prepared when CANVAS_POSTGRES_MODE=external.');
  }
  next.env.CANVAS_POSTGRES_MODE = 'managed';
  let databaseUrl = String(next.env.DATABASE_URL || '').trim();
  const parsedDatabaseUrl = databaseUrlParts(databaseUrl);
  if (parsedDatabaseUrl) {
    requireUrlSafePostgresPart('CANVAS_POSTGRES_USER', parsedDatabaseUrl.user);
    requireUrlSafePostgresPart('CANVAS_POSTGRES_DB', parsedDatabaseUrl.database);
    next.env.CANVAS_POSTGRES_USER = parsedDatabaseUrl.user;
    next.env.CANVAS_POSTGRES_PASSWORD = parsedDatabaseUrl.password;
    next.env.CANVAS_POSTGRES_DB = parsedDatabaseUrl.database;
  }
  next.env.CANVAS_POSTGRES_REQUIRED = true;
  next.env.CANVAS_POSTGRES_IMAGE = next.env.CANVAS_POSTGRES_IMAGE || DEFAULT_POSTGRES_IMAGE;
  next.env.CANVAS_POSTGRES_DATA_VOLUME = next.env.CANVAS_POSTGRES_DATA_VOLUME || DEFAULT_POSTGRES_DATA_VOLUME;
  next.env.CANVAS_POSTGRES_DB = next.env.CANVAS_POSTGRES_DB || DEFAULT_POSTGRES_DB;
  next.env.CANVAS_POSTGRES_USER = next.env.CANVAS_POSTGRES_USER || DEFAULT_POSTGRES_USER;
  if (!String(next.env.CANVAS_POSTGRES_PASSWORD || '').trim()) {
    if (options.allowSecretGeneration === false) {
      throw new Error('Managed Postgres credentials are missing. Run: canvas-notebook database prepare-postgres');
    }
    next.env.CANVAS_POSTGRES_PASSWORD = randomSecret().replace(/[+/=]/g, '').slice(0, 32);
  }
  validateDatabaseUrl(databaseUrl);
  if (!databaseUrl) {
    requireUrlSafePostgresPart('CANVAS_POSTGRES_USER', next.env.CANVAS_POSTGRES_USER);
    requireUrlSafePostgresPart('CANVAS_POSTGRES_PASSWORD', next.env.CANVAS_POSTGRES_PASSWORD);
    requireUrlSafePostgresPart('CANVAS_POSTGRES_DB', next.env.CANVAS_POSTGRES_DB);
    databaseUrl = `postgresql://${next.env.CANVAS_POSTGRES_USER}:${next.env.CANVAS_POSTGRES_PASSWORD}@postgres:5432/${next.env.CANVAS_POSTGRES_DB}`;
    next.env.DATABASE_URL = databaseUrl;
  }
  return next;
}

export function normalizeDatabaseConfig(
  config: CanvasCliConfig,
  options: { allowSecretGeneration?: boolean } = {},
): CanvasCliConfig {
  const next = structuredClone(config);
  const rawProvider = normalized(next.env.CANVAS_DATABASE_PROVIDER);
  const provider = !rawProvider && /^postgres(?:ql)?:\/\//iu.test(String(next.env.DATABASE_URL || '').trim())
    ? 'postgres'
    : normalizeDatabaseProviderValue(next.env.CANVAS_DATABASE_PROVIDER);
  next.env.CANVAS_DATABASE_PROVIDER = provider;

  if (deploymentRequiresPostgres(next.env.CANVAS_DEPLOYMENT_MODE, next.env.CANVAS_TEAM_FEATURES_ENABLED) && provider !== 'postgres') {
    throw new Error(`${next.env.CANVAS_DEPLOYMENT_MODE || 'This deployment'} requires CANVAS_DATABASE_PROVIDER=postgres.`);
  }

  if (next.env.CANVAS_DATABASE_PROVIDER !== 'postgres') {
    next.env.CANVAS_POSTGRES_MODE = '';
    next.env.CANVAS_POSTGRES_VECTOR_ENABLED = false;
    return next;
  }

  const postgresMode = normalizePostgresModeValue(next.env.CANVAS_POSTGRES_MODE);
  next.env.CANVAS_POSTGRES_MODE = postgresMode;
  if (postgresMode === 'external') {
    validateDatabaseUrl(next.env.DATABASE_URL);
    if (!String(next.env.DATABASE_URL || '').trim()) {
      throw new Error('External Postgres requires DATABASE_URL.');
    }
    next.env.CANVAS_POSTGRES_REQUIRED = true;
    next.env.CANVAS_POSTGRES_PASSWORD = '';
    return next;
  }

  const prepared = ensurePostgresInfrastructureConfig(next, options);
  validateDatabaseUrl(prepared.env.DATABASE_URL);
  if (!String(prepared.env.DATABASE_URL || '').trim()) {
    requireUrlSafePostgresPart('CANVAS_POSTGRES_USER', prepared.env.CANVAS_POSTGRES_USER);
    requireUrlSafePostgresPart('CANVAS_POSTGRES_PASSWORD', prepared.env.CANVAS_POSTGRES_PASSWORD);
    requireUrlSafePostgresPart('CANVAS_POSTGRES_DB', prepared.env.CANVAS_POSTGRES_DB);
    prepared.env.DATABASE_URL = `postgresql://${prepared.env.CANVAS_POSTGRES_USER}:${prepared.env.CANVAS_POSTGRES_PASSWORD}@postgres:5432/${prepared.env.CANVAS_POSTGRES_DB}`;
  }
  prepared.env.CANVAS_POSTGRES_VECTOR_ENABLED = true;
  return prepared;
}

export function materializePostgresInfrastructureConfig(config: CanvasCliConfig, baseUrl?: string): CanvasCliConfig {
  const next = ensureBaseUrl(ensureSecrets(config), baseUrl);
  next.env.CANVAS_POSTGRES_MODE = 'managed';
  return ensurePostgresInfrastructureConfig(next, { allowSecretGeneration: true });
}

export function materializeConfig(
  config: CanvasCliConfig,
  baseUrl?: string,
  options: { allowPostgresSecretGeneration?: boolean } = {},
): CanvasCliConfig {
  return normalizeDatabaseConfig(ensureBaseUrl(ensureSecrets(config), baseUrl), {
    allowSecretGeneration: options.allowPostgresSecretGeneration,
  });
}

export function redactConfig(config: CanvasCliConfig): CanvasCliConfig {
  const next = structuredClone(config);
  for (const key of Object.keys(next.env).filter(isSensitiveEnvKey)) {
    const value = String(next.env[key] || '');
    next.env[key] = key.toUpperCase() === 'DATABASE_URL'
      ? (value.trim() ? 'postgresql://***' : '(not set)')
      : (value ? `${value.slice(0, 4)}***` : '(not set)');
  }
  for (const key of ['BETTER_AUTH_SECRET', 'CANVAS_INTERNAL_API_KEY', 'DATABASE_URL', 'CANVAS_POSTGRES_PASSWORD']) {
    if (!(key in next.env)) next.env[key] = '(not set)';
  }
  return next;
}

export function isSensitiveEnvKey(key: string): boolean {
  return key.toUpperCase() === 'DATABASE_URL' || /(?:^|_)(?:PASSWORD|PASSWD|SECRET_KEY|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|LICENSE_CERT)$/iu.test(key);
}

function secretStateFingerprint(value: string, installDir: string): string {
  return crypto.scryptSync(value, SECRET_FINGERPRINT_DOMAIN + '\0' + installDir, 32, SCRYPT_OPTIONS).toString('hex');
}

export function configSecretState(config: CanvasCliConfig): Record<string, { present: boolean; fingerprint: string | null }> {
  const mandatoryKeys = ['BETTER_AUTH_SECRET', 'CANVAS_INTERNAL_API_KEY', 'DATABASE_URL', 'CANVAS_POSTGRES_PASSWORD'];
  const keys = [...mandatoryKeys, ...Object.keys(config.env).filter((key) => isSensitiveEnvKey(key) && !mandatoryKeys.includes(key))];
  return Object.fromEntries(
    keys.map((key) => {
      const value = String(config.env[key] || '');
      return [key, {
        present: value.length > 0,
        fingerprint: value.length > 0 ? secretStateFingerprint(value, config.paths.installDir) : null,
      }];
    }),
  );
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
  const postgresProfile = String(config.env.CANVAS_DATABASE_PROVIDER || 'sqlite') === 'postgres'
    && normalizePostgresModeValue(config.env.CANVAS_POSTGRES_MODE) === 'managed'
    ? 'postgres'
    : '';
  const entries: Record<string, EnvValue> = {
    CANVAS_IMAGE: config.image,
    HOST_PORT: config.hostPort,
    CONTAINER_PORT: config.containerPort,
    DATA_DIR: composeDataDir,
    COMPOSE_PROFILES: postgresProfile,
    CANVAS_DATABASE_PROVIDER: config.env.CANVAS_DATABASE_PROVIDER,
    CANVAS_POSTGRES_MODE: config.env.CANVAS_POSTGRES_MODE,
    CANVAS_POSTGRES_IMAGE: config.env.CANVAS_POSTGRES_IMAGE || 'pgvector/pgvector:0.8.3-pg18',
    CANVAS_POSTGRES_DATA_VOLUME: config.env.CANVAS_POSTGRES_DATA_VOLUME || 'canvas-postgres-data',
    CANVAS_POSTGRES_DB: config.env.CANVAS_POSTGRES_DB || 'canvas_notebook',
    CANVAS_POSTGRES_USER: config.env.CANVAS_POSTGRES_USER || 'canvas',
    CANVAS_POSTGRES_PASSWORD: config.env.CANVAS_POSTGRES_PASSWORD || '',
    CANVAS_STANDALONE_UPDATER_ENABLED: config.env.CANVAS_STANDALONE_UPDATER_ENABLED || false,
    CANVAS_UPDATER_GID: config.env.CANVAS_UPDATER_GID || '',
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
  await writeSecureFile(config.paths.containerEnvFile, containerEnvText(config));
  await writeSecureFile(config.paths.composeEnvFile, composeEnvText(config, composeDataDir));
}
