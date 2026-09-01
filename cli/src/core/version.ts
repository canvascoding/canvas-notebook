import fs from 'node:fs/promises';
import path from 'node:path';

export const CLI_GENERATION = 'typescript' as const;
export const CONFIG_SCHEMA_VERSION = 1;

export const CLI_COMMANDS = [
  'help',
  'version',
  'install',
  'update',
  'start',
  'restart',
  'stop',
  'down',
  'status',
  'ps',
  'health',
  'diagnose',
  'logs',
  'container-logs',
  'manager-log',
  'cleanup-logs',
  'swap',
  'swap-sync',
  'swap-apply',
  'swap-enable',
  'swap-disable',
  'caddy',
  'caddy-reload',
  'caddy-fix',
  'auto-update-status',
  'auto-update-enable',
  'auto-update-disable',
  'auto-update-sync',
  'env',
  'config',
  'config-show',
  'config-set',
  'config-migrate',
  'cli-update',
  'admin',
  'backup',
  'database',
  'service',
] as const;

async function readVersionFromRoot(root: string): Promise<string> {
  const version = await fs.readFile(path.join(root, 'VERSION'), 'utf8')
    .then((value) => value.trim(), () => '');
  if (version) return version;
  return fs.readFile(path.join(root, 'package.json'), 'utf8')
    .then((value) => {
      const parsed = JSON.parse(value) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version.trim() : '';
    }, () => '')
    .catch(() => '');
}

export async function resolveCliVersion(
  env: NodeJS.ProcessEnv = process.env,
  moduleDirectory = __dirname,
): Promise<string> {
  const explicitVersion = String(env.CANVAS_CLI_VERSION || '').trim();
  if (explicitVersion) return explicitVersion;

  const candidateRoots = [
    env.CANVAS_CLI_ROOT ? path.resolve(env.CANVAS_CLI_ROOT) : '',
    path.resolve(moduleDirectory, '..', '..'),
    path.resolve(moduleDirectory, '..', '..', '..'),
    process.cwd(),
  ].filter((value, index, values) => value && values.indexOf(value) === index);

  for (const root of candidateRoots) {
    const version = await readVersionFromRoot(root);
    if (version) return version;
  }

  return String(env.npm_package_version || '').trim() || 'unknown';
}
