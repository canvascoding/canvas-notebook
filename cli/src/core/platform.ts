import os from 'node:os';
import path from 'node:path';

import type { CliPaths, HostPlatform, RuntimeContext, ServiceMode } from './types';

export function detectHostPlatform(nodePlatform = process.platform): HostPlatform {
  if (nodePlatform === 'darwin') return 'macos';
  if (nodePlatform === 'win32') return 'windows';
  return 'linux';
}

export function defaultServiceMode(platform: HostPlatform): ServiceMode {
  if (platform === 'linux') return 'systemd';
  if (platform === 'macos') return 'launchd';
  if (platform === 'windows') return 'scheduled-task';
  return 'none';
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function localAppData(env: NodeJS.ProcessEnv): string {
  return env.LOCALAPPDATA || path.join(homeDir(env), 'AppData', 'Local');
}

export function resolveDefaultPaths(
  platform = detectHostPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): CliPaths {
  const home = homeDir(env);

  const installDir = env.CANVAS_INSTALL_DIR || (() => {
    if (platform === 'macos') return path.join(home, 'Library', 'Application Support', 'Canvas Notebook', 'manager');
    if (platform === 'windows') return path.join(localAppData(env), 'Canvas Notebook', 'manager');
    return '/opt/canvas-notebook';
  })();

  const dataDir = env.CANVAS_DATA_DIR || env.DATA_DIR || (() => {
    if (platform === 'macos') return path.join(home, 'Library', 'Application Support', 'Canvas Notebook', 'data');
    if (platform === 'windows') return path.join(localAppData(env), 'Canvas Notebook', 'data');
    return path.join(home, 'canvas-notebook-data');
  })();

  const logFile = env.CANVAS_MANAGER_LOG_FILE || (() => {
    if (platform === 'macos') return path.join(home, 'Library', 'Logs', 'Canvas Notebook', 'manager.log');
    if (platform === 'windows') return path.join(localAppData(env), 'Canvas Notebook', 'logs', 'manager.log');
    return path.join(env.CANVAS_MANAGER_LOG_DIR || '/var/log/canvas-notebook', 'manager.log');
  })();

  return {
    installDir,
    dataDir,
    configFile: env.CANVAS_CONFIG_JSON || path.join(installDir, 'canvas-notebook-config.json'),
    composeFile: env.CANVAS_COMPOSE_FILE || path.join(installDir, 'canvas-notebook-compose.yaml'),
    containerEnvFile: env.CANVAS_CONFIG_ENV || path.join(installDir, 'canvas-notebook.env'),
    composeEnvFile: env.CANVAS_COMPOSE_ENV || path.join(installDir, '.env'),
    logFile,
  };
}

export function createRuntimeContext(env: NodeJS.ProcessEnv = process.env): RuntimeContext {
  const platform = detectHostPlatform();
  return {
    platform,
    paths: resolveDefaultPaths(platform, env),
    serviceName: env.CANVAS_SERVICE || 'canvas-notebook',
    dockerBin: platform === 'windows' ? 'docker.exe' : 'docker',
  };
}

export function composePath(value: string, platform: HostPlatform): string {
  if (platform === 'windows') return value.replace(/\\/g, '/');
  return value;
}
