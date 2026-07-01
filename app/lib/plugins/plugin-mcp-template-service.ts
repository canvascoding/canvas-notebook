import { promises as fs } from 'fs';
import path from 'path';

import { isPathInside } from '@/app/lib/plugins/canvas-plugin-manifest';

export interface PluginMcpTemplateFile {
  rawContent: string;
  config?: Record<string, unknown>;
}

export function normalizePluginMcpTemplatePath(value: string): string {
  const normalized = value
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '');
  const pathSegments = normalized.split('/').filter(Boolean);
  if (
    !normalized
    || path.isAbsolute(normalized)
    || pathSegments.length === 0
    || pathSegments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid connector config path.');
  }
  return pathSegments.join('/');
}

export function parsePluginMcpTemplateJson(rawContent: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(rawContent) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readPluginMcpTemplateFile(params: {
  rootDir: string;
  configPath: string;
}): Promise<PluginMcpTemplateFile> {
  const relativePath = normalizePluginMcpTemplatePath(params.configPath);
  const targetPath = path.join(params.rootDir, relativePath);
  if (!isPathInside(params.rootDir, targetPath)) {
    throw new Error('Invalid connector config path.');
  }

  const rawContent = await fs.readFile(targetPath, 'utf-8');
  return {
    rawContent,
    config: parsePluginMcpTemplateJson(rawContent),
  };
}
