import fs from 'node:fs';
import path from 'node:path';

const CONTAINER_DATA_ROOT = '/data';

function directoryExists(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveProjectDataRoot(cwd = process.cwd()): string {
  return path.resolve(cwd, 'data');
}

export function resolveCanvasDataRoot(cwd = process.cwd()): string {
  const configured = process.env.CANVAS_DATA_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  if (directoryExists(CONTAINER_DATA_ROOT)) {
    return CONTAINER_DATA_ROOT;
  }

  return resolveProjectDataRoot(cwd);
}

export function resolveAgentStorageDir(cwd = process.cwd()): string {
  return path.join(resolveCanvasDataRoot(cwd), 'canvas-agent');
}

export function resolveSecretsDir(cwd = process.cwd()): string {
  return path.join(resolveCanvasDataRoot(cwd), 'secrets');
}

export function resolveSkillsDataDir(cwd = process.cwd()): string {
  return path.join(resolveCanvasDataRoot(cwd), 'skills');
}

export function resolveDefaultIntegrationsEnvPath(cwd = process.cwd()): string {
  return path.join(resolveSecretsDir(cwd), 'Canvas-Integrations.env');
}

export function resolveDefaultAgentsEnvPath(cwd = process.cwd()): string {
  return path.join(resolveSecretsDir(cwd), 'Canvas-Agents.env');
}
