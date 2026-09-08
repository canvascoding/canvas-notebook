import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { getAgentRuntimeTempEnv } from '@/app/lib/pi/agent-runtime-temp';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';

export type AgentBashWorkingDirectory = 'temp' | 'workspace';
export type AgentBashSandboxMode = 'landlock' | 'local-development';

const execFileAsync = promisify(execFile);
const DEFAULT_LANDLOCK_LAUNCHER = '/usr/local/libexec/canvas-agent-landlock';
const AGENT_BASH_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const AGENT_BASH_WORKING_DIRECTORIES = new Set<AgentBashWorkingDirectory>(['temp', 'workspace']);

export function resolveAgentBashWorkingDirectory(
  requested: unknown,
  hasExecutionContext: boolean,
): AgentBashWorkingDirectory {
  if (requested === undefined || requested === null || requested === '') {
    return hasExecutionContext ? 'temp' : 'workspace';
  }
  if (typeof requested !== 'string' || !AGENT_BASH_WORKING_DIRECTORIES.has(requested as AgentBashWorkingDirectory)) {
    throw new Error('workingDirectory must be either "temp" or "workspace".');
  }
  if (requested === 'temp' && !hasExecutionContext) {
    throw new Error('workingDirectory "temp" requires an active agent execution context.');
  }
  return requested as AgentBashWorkingDirectory;
}

function copyDefinedEnvironmentValue(
  target: NodeJS.ProcessEnv,
  source: Partial<NodeJS.ProcessEnv>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === 'string' && value.length > 0) {
    target[key] = value;
  }
}

export function buildAgentBashEnvironment(params: {
  sourceEnv: Partial<NodeJS.ProcessEnv>;
  workspaceDir: string;
  tempDir: string | null;
}): NodeJS.ProcessEnv {
  const runtimeBin = path.dirname(process.execPath);
  const executablePaths = [
    runtimeBin,
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/data/cache/.bun/bin',
    '/home/node/.npm-global/bin',
  ];
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: params.sourceEnv.NODE_ENV ?? 'production',
    PATH: [...new Set(executablePaths)].join(path.delimiter),
    CANVAS_WORKSPACE_DIR: params.workspaceDir,
  };

  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM']) {
    copyDefinedEnvironmentValue(env, params.sourceEnv, key);
  }
  for (const key of ['NODE_PATH', 'LD_LIBRARY_PATH', 'PKG_CONFIG_PATH', 'CHROMIUM_PATH']) {
    copyDefinedEnvironmentValue(env, params.sourceEnv, key);
  }

  if (params.tempDir) {
    const homeDir = path.join(params.tempDir, 'home');
    Object.assign(env, getAgentRuntimeTempEnv(params.tempDir), {
      HOME: homeDir,
      XDG_CACHE_HOME: path.join(params.tempDir, 'cache'),
      XDG_CONFIG_HOME: path.join(params.tempDir, 'config'),
      XDG_DATA_HOME: path.join(params.tempDir, 'share'),
      XDG_RUNTIME_DIR: path.join(params.tempDir, 'run'),
    });
  }

  return env;
}

export function resolveAgentBashSandboxMode(env: Partial<NodeJS.ProcessEnv>): AgentBashSandboxMode {
  if (env.CANVAS_RUNTIME_ENV === 'docker' || env.CANVAS_AGENT_BASH_SANDBOX === 'required') {
    return 'landlock';
  }
  return 'local-development';
}

async function canonicalExistingPath(candidatePath: string): Promise<string | null> {
  try {
    return await fs.realpath(candidatePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function canonicalExistingPaths(candidatePaths: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(candidatePaths.map((candidatePath) => canonicalExistingPath(candidatePath)));
  return [...new Set(resolved.filter((candidatePath): candidatePath is string => Boolean(candidatePath)))];
}

export async function buildAgentLandlockArguments(params: {
  command: string;
  cwd: string;
  workspaceDir: string;
  tempDir: string;
  skillReadRoots?: readonly string[];
}): Promise<string[]> {
  const [canonicalCwd, canonicalWorkspace, canonicalTemp] = await Promise.all([
    fs.realpath(params.cwd),
    fs.realpath(params.workspaceDir),
    fs.realpath(params.tempDir),
  ]);
  const readOnlyRoots = await canonicalExistingPaths([
    '/usr',
    '/etc',
    '/app',
    '/var/cache/fontconfig',
    '/var/lib/libreoffice',
    '/data/cache/.bun',
    '/home/node/.npm-global',
    canonicalWorkspace,
    ...(params.skillReadRoots ?? []),
  ]);
  const writableDeviceFiles = await canonicalExistingPaths([
    '/dev/null',
    '/dev/zero',
    '/dev/random',
    '/dev/urandom',
  ]);
  const args = ['--cwd', canonicalCwd];
  for (const readOnlyRoot of readOnlyRoots) {
    args.push('--ro', readOnlyRoot);
  }
  args.push('--rw', canonicalTemp);
  for (const writableDeviceFile of writableDeviceFiles) {
    args.push('--rw-file', writableDeviceFile);
  }
  args.push('--', '/bin/bash', '-lc', params.command);
  return args;
}

export async function executeAgentBashCommand(params: {
  command: string;
  cwd: string;
  workspaceDir: string;
  tempDir: string | null;
  env: NodeJS.ProcessEnv;
  executionContext: AgentExecutionContext | null;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; sandboxMode: AgentBashSandboxMode }> {
  const sandboxMode = resolveAgentBashSandboxMode(process.env);
  if (sandboxMode === 'local-development') {
    const result = await execFileAsync('/bin/bash', ['-lc', params.command], {
      cwd: params.cwd,
      env: params.env,
      signal: params.signal,
      maxBuffer: AGENT_BASH_MAX_BUFFER_BYTES,
      encoding: 'utf8',
    });
    return { stdout: result.stdout, stderr: result.stderr, sandboxMode };
  }

  if (!params.tempDir || !params.executionContext) {
    throw new Error('The Landlock sandbox requires an active agent execution context and session temp directory.');
  }
  const launcherPath = process.env.CANVAS_AGENT_LANDLOCK_PATH?.trim() || DEFAULT_LANDLOCK_LAUNCHER;
  await fs.access(launcherPath, fsConstants.X_OK).catch(() => {
    throw new Error(`Agent Bash is unavailable because the required Landlock launcher is not executable: ${launcherPath}`);
  });
  const args = await buildAgentLandlockArguments({
    command: params.command,
    cwd: params.cwd,
    workspaceDir: params.workspaceDir,
    tempDir: params.tempDir,
    skillReadRoots: params.executionContext.skillReadRoots,
  });
  const result = await execFileAsync(launcherPath, args, {
    cwd: params.tempDir,
    env: params.env,
    signal: params.signal,
    maxBuffer: AGENT_BASH_MAX_BUFFER_BYTES,
    encoding: 'utf8',
  });
  return { stdout: result.stdout, stderr: result.stderr, sandboxMode };
}
