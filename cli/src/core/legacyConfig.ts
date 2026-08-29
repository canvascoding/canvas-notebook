import fs from 'node:fs/promises';
import path from 'node:path';

import { createDefaultConfig, isSensitiveEnvKey, normalizeConfig } from './config';
import type { CanvasCliConfig, EnvValue, RuntimeContext } from './types';

export interface LegacyConfigMigrationResult {
  config: CanvasCliConfig;
  configFile: string;
  skipped: boolean;
  sources: string[];
}

function parseEnvText(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function composeScalar(raw: string): string {
  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/u, '').trim();
  }
  const fallback = value.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}$/u);
  if (fallback) return fallback[1];
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(value)) return '';
  return value;
}

function composeValue(content: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = content.match(new RegExp(`^\\s*${escapedKey}:\\s*(.+?)\\s*$`, 'mu'));
  return match ? composeScalar(match[1]) : '';
}

function applyManagerEnv(config: CanvasCliConfig, values: Record<string, string>): void {
  if (values.CANVAS_SWAP_ENABLED) config.swap.enabled = !['false', '0', 'no', 'off', 'disabled'].includes(values.CANVAS_SWAP_ENABLED.toLowerCase());
  if (values.CANVAS_SWAP_SIZE) config.swap.size = values.CANVAS_SWAP_SIZE.toUpperCase();
  if (values.CANVAS_SWAP_FILE) config.swap.file = values.CANVAS_SWAP_FILE;
  if (/^\d+$/u.test(values.CANVAS_SWAP_SWAPPINESS || '')) config.swap.swappiness = Number(values.CANVAS_SWAP_SWAPPINESS);
  if (values.CANVAS_AUTO_UPDATE_ENABLED) config.autoUpdate.enabled = !['false', '0', 'no', 'off', 'disabled'].includes(values.CANVAS_AUTO_UPDATE_ENABLED.toLowerCase());
  if (values.CANVAS_AUTO_UPDATE_SCHEDULE) config.autoUpdate.schedule = values.CANVAS_AUTO_UPDATE_SCHEDULE;
  if (values.CANVAS_IMAGE) config.image = values.CANVAS_IMAGE;
  if (values.DATA_DIR) config.dataDir = values.DATA_DIR;
}

function applyRuntimeEnv(config: CanvasCliConfig, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (key === 'CANVAS_IMAGE' && value) config.image = value;
    else if (key === 'HOST_PORT' && /^\d+$/u.test(value)) config.hostPort = Number(value);
    else if (key === 'CONTAINER_PORT' && /^\d+$/u.test(value)) config.containerPort = Number(value);
    else if (key === 'DATA_DIR' && value) config.dataDir = value;
    else if (key === 'COMPOSE_PROFILES') continue;
    else config.env[key] = value;
  }
}

function applyCompose(config: CanvasCliConfig, content: string, installDir: string): void {
  const image = composeValue(content, 'image');
  if (image) config.image = image;
  for (const key of [
    'BETTER_AUTH_SECRET',
    'CANVAS_INTERNAL_API_KEY',
    'BETTER_AUTH_BASE_URL',
    'BASE_URL',
    'CANVAS_DATABASE_PROVIDER',
    'DATABASE_URL',
    'CANVAS_POSTGRES_IMAGE',
    'CANVAS_POSTGRES_DATA_VOLUME',
    'CANVAS_POSTGRES_DB',
    'CANVAS_POSTGRES_USER',
    'CANVAS_POSTGRES_PASSWORD',
  ]) {
    const value = composeValue(content, key);
    if (value && !value.startsWith('change-me-') && value !== 'https://your-domain.com') config.env[key] = value;
  }

  const port = content.match(/^\s*-\s*["']?(\d+):(\d+)["']?\s*$/mu);
  if (port) {
    config.hostPort = Number(port[1]);
    config.containerPort = Number(port[2]);
  }
  const mount = content.match(/^\s*-\s*["']?(.+?):\/data(?:[:"']|\s|$)/mu);
  if (mount) {
    const source = composeScalar(mount[1]);
    if (source) config.dataDir = path.isAbsolute(source) ? source : path.resolve(installDir, source);
  }
}

function protectedExistingEnv(config: CanvasCliConfig | null): Record<string, EnvValue> {
  if (!config) return {};
  const protectedKeys = new Set([
    'DATABASE_URL',
    'CANVAS_POSTGRES_USER',
    'CANVAS_POSTGRES_DB',
    'CANVAS_POSTGRES_PASSWORD',
    'CANVAS_POSTGRES_DATA_VOLUME',
  ]);
  return Object.fromEntries(Object.entries(config.env).filter(([key, value]) =>
    value !== '' && value !== null && value !== undefined && (protectedKeys.has(key) || isSensitiveEnvKey(key))));
}

async function readIfPresent(filePath: string): Promise<string | null> {
  return fs.readFile(filePath, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
}

export async function migrateLegacyConfig(params: {
  context: RuntimeContext;
  currentConfig: CanvasCliConfig;
  force: boolean;
  managerEnvPath?: string;
}): Promise<LegacyConfigMigrationResult> {
  const { context, currentConfig, force } = params;
  const existingText = await readIfPresent(context.paths.configFile);
  if (existingText !== null && !force) {
    return { config: currentConfig, configFile: context.paths.configFile, skipped: true, sources: [] };
  }

  const existingConfig = existingText === null ? null : currentConfig;
  const config = structuredClone(existingConfig || createDefaultConfig(context.paths, context.platform));
  const protectedEnv = protectedExistingEnv(existingConfig);
  const sources: string[] = [];
  const managerEnvPath = params.managerEnvPath || process.env.CANVAS_MANAGER_ENV_PATH || '/etc/canvas-notebook/manager.env';

  const managerEnv = await readIfPresent(managerEnvPath);
  if (managerEnv !== null) {
    applyManagerEnv(config, parseEnvText(managerEnv));
    sources.push(managerEnvPath);
  }
  const compose = await readIfPresent(context.paths.composeFile);
  if (compose !== null) {
    applyCompose(config, compose, context.paths.installDir);
    sources.push(context.paths.composeFile);
  }
  const composeEnv = await readIfPresent(context.paths.composeEnvFile);
  if (composeEnv !== null) {
    applyRuntimeEnv(config, parseEnvText(composeEnv));
    sources.push(context.paths.composeEnvFile);
  }
  const containerEnv = await readIfPresent(context.paths.containerEnvFile);
  if (containerEnv !== null) {
    applyRuntimeEnv(config, parseEnvText(containerEnv));
    sources.push(context.paths.containerEnvFile);
  }

  Object.assign(config.env, protectedEnv);
  if (config.dataDir && !path.isAbsolute(config.dataDir)) {
    config.dataDir = path.resolve(context.paths.installDir, config.dataDir);
  }
  const baseUrl = String(config.env.BETTER_AUTH_BASE_URL || config.env.BASE_URL || '').trim();
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') config.domain = parsed.hostname;
    } catch {
      // normalizeConfig keeps the remaining safely imported values; env --render will surface an invalid URL.
    }
  }
  const normalized = normalizeConfig(config, createDefaultConfig(context.paths, context.platform));
  normalized.platform = { ...currentConfig.platform };
  normalized.paths = { ...context.paths, dataDir: normalized.dataDir };
  return { config: normalized, configFile: context.paths.configFile, skipped: false, sources };
}
