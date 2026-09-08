import 'server-only';

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import {
  ensureAgentRuntimeTempDir,
  getAgentRuntimeTempEnv,
  resolveAgentRuntimeTempDir,
} from '@/app/lib/pi/agent-runtime-temp';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';

const execFileAsync = promisify(execFile);

export class AgentShellSandboxError extends Error {
  readonly code = 'AGENT_SHELL_SANDBOX_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'AgentShellSandboxError';
  }
}

export type AgentSandboxedProcess = { executable: string; args: readonly string[] };
type AgentSandboxedProcessOptions = {
  context: AgentExecutionContext | null;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  cwd?: string;
  maxBuffer?: number;
};

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function prepareScratchDirectory(context: AgentExecutionContext): Promise<string> {
  const dataRoot = path.resolve(resolveCanvasDataRoot());
  const temporaryRoot = resolveAgentRuntimeTempDir(context);
  if (!isWithin(temporaryRoot, dataRoot) || temporaryRoot === dataRoot) {
    throw new AgentShellSandboxError('The agent scratch directory is outside the managed runtime storage.');
  }

  // The configured data root may itself be a mount/symlink. None of the
  // agent-controlled descendants may redirect a write grant to another scope.
  let current = dataRoot;
  for (const segment of path.relative(dataRoot, temporaryRoot).split(path.sep)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
      throw new AgentShellSandboxError('The agent scratch directory must not contain symbolic links.');
    }
  }

  const canonicalWorkspace = await fs.realpath(context.workspaceRoot);
  // Check before ensureAgentRuntimeTempDir touches an existing directory.
  const canonicalDataRoot = await fs.realpath(dataRoot);
  const expectedScratch = path.join(canonicalDataRoot, path.relative(dataRoot, temporaryRoot));
  if (isWithin(canonicalWorkspace, expectedScratch) || isWithin(expectedScratch, canonicalWorkspace)) {
    throw new AgentShellSandboxError('The agent scratch directory must be separate from the workspace.');
  }
  const prepared = await ensureAgentRuntimeTempDir(context);
  const canonicalScratch = await fs.realpath(prepared);
  if (canonicalScratch !== expectedScratch) {
    throw new AgentShellSandboxError('The agent scratch directory changed while the sandbox was being prepared.');
  }
  return canonicalScratch;
}

export function buildAgentShellSandboxLaunch(input: {
  platform: NodeJS.Platform;
  scratchDirectory: string;
  command: string | AgentSandboxedProcess;
  appRoot: string;
}): { executable: string; args: string[] } {
  const command = typeof input.command === 'string'
    ? { executable: '/bin/sh', args: ['-c', input.command] }
    : input.command;
  if (input.platform === 'darwin') {
    return {
      executable: '/usr/bin/sandbox-exec',
      args: [
        '-p',
        [
          '(version 1)',
          '(allow default)',
          '(deny file-write*)',
          '(allow file-write* (subpath (param "SCRATCH")))',
          '(allow file-write-data (literal "/dev/null"))',
          // A child must not issue a new sandbox extension to widen its
          // filesystem rights.
          '(deny file-issue-extension)',
        ].join('\n'),
        '-D', `SCRATCH=${input.scratchDirectory}`,
        command.executable, ...command.args,
      ],
    };
  }
  if (input.platform === 'linux') {
    return {
      executable: '/usr/bin/python3',
      args: [
        // Do not import sitecustomize or Python modules from the workspace
        // before kernel confinement has been activated.
        '-I', '-B',
        path.join(input.appRoot, 'scripts', 'runtime', 'agent-shell-sandbox.py'),
        input.scratchDirectory,
        command.executable, ...command.args,
      ],
    };
  }
  throw new AgentShellSandboxError(`Agent shell filesystem isolation is unavailable on ${input.platform}.`);
}

/**
 * Confines direct filesystem mutations of the shell and all its descendants.
 * This is not a network sandbox or an isolation boundary for external MCP
 * servers. A missing/unsupported OS sandbox never falls back to plain exec.
 */
export async function executeAgentSandboxedCommand(command: string, options: {
  context: AgentExecutionContext | null;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> {
  if (!options.context) {
    throw new AgentShellSandboxError('Agent shell execution requires a workspace-bound session.');
  }
  options.signal?.throwIfAborted();
  const scratchDirectory = await prepareScratchDirectory(options.context);
  return executePreparedAgentProcess({ executable: '/bin/sh', args: ['-c', command] }, {
    ...options,
    env: {
      ...options.env,
      ...getAgentRuntimeTempEnv(scratchDirectory),
      HOME: scratchDirectory,
      XDG_CACHE_HOME: path.join(scratchDirectory, '.cache'),
      XDG_CONFIG_HOME: path.join(scratchDirectory, '.config'),
      XDG_DATA_HOME: path.join(scratchDirectory, '.local', 'share'),
      XDG_STATE_HOME: path.join(scratchDirectory, '.local', 'state'),
    },
  }, scratchDirectory);
}

/** Preserve the calling runtime's validated environment, cwd and argv. */
export async function executeAgentSandboxedProcess(
  command: AgentSandboxedProcess,
  options: AgentSandboxedProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (!options.context) {
    throw new AgentShellSandboxError('Agent shell execution requires a workspace-bound session.');
  }
  options.signal?.throwIfAborted();
  const scratchDirectory = await prepareScratchDirectory(options.context);
  return executePreparedAgentProcess(command, options, scratchDirectory);
}

async function executePreparedAgentProcess(
  command: AgentSandboxedProcess,
  options: AgentSandboxedProcessOptions,
  scratchDirectory: string,
): Promise<{ stdout: string; stderr: string }> {
  const launch = buildAgentShellSandboxLaunch({
    platform: process.platform,
    scratchDirectory,
    command,
    appRoot: process.env.CANVAS_APP_ROOT?.trim() || process.cwd(),
  });
  try {
    return await execFileAsync(launch.executable, launch.args, {
      cwd: await fs.realpath(options.cwd ?? options.context!.workspaceRoot),
      env: options.env,
      signal: options.signal,
      maxBuffer: options.maxBuffer,
      encoding: 'utf8',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AgentShellSandboxError('The required operating-system shell sandbox is unavailable.');
    }
    throw error;
  }
}
