import path from 'node:path';

import { getAgentRuntimeTempEnv } from '@/app/lib/pi/agent-runtime-temp';

export type AgentBashWorkingDirectory = 'temp' | 'workspace';

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
  source: NodeJS.ProcessEnv,
  key: string,
): void {
  const value = source[key];
  if (typeof value === 'string' && value.length > 0) {
    target[key] = value;
  }
}

export function buildAgentBashEnvironment(params: {
  sourceEnv: NodeJS.ProcessEnv;
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
