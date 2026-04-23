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

function resolveProjectDataRoot(cwd?: string): string {
  const resolvedCwd = cwd ?? process.cwd();
  return path.resolve(/*turbopackIgnore: true*/ resolvedCwd, 'data');
}

export function resolveCanvasDataRoot(cwd?: string): string {
  const configured = process.env.CANVAS_DATA_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  if (directoryExists(CONTAINER_DATA_ROOT)) {
    return CONTAINER_DATA_ROOT;
  }

  return resolveProjectDataRoot(cwd);
}

export function resolveAgentStorageDir(cwd?: string): string {
  return path.join(resolveCanvasDataRoot(cwd), 'canvas-agent');
}

export function resolveSecretsDir(cwd?: string): string {
  return path.join(resolveCanvasDataRoot(cwd), 'secrets');
}

export function resolveSkillsDataDir(cwd?: string): string {
  return path.join(resolveCanvasDataRoot(cwd), 'skills');
}

export function resolveDefaultIntegrationsEnvPath(cwd?: string): string {
  return path.join(resolveSecretsDir(cwd), 'Canvas-Integrations.env');
}

export function resolveDefaultAgentsEnvPath(cwd?: string): string {
  return path.join(resolveSecretsDir(cwd), 'Canvas-Agents.env');
}

export function getUserUploadsRoot(cwd?: string): string {
  return path.join(resolveCanvasDataRoot(cwd), 'user-uploads');
}

export function getUserUploadsStudioRefRoot(cwd?: string): string {
  return path.join(resolveCanvasDataRoot(cwd), 'user-uploads', 'studio-references');
}
