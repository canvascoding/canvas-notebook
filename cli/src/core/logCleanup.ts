import type { CanvasCliConfig, CommandRunner, RuntimeContext } from './types';

export function orphanedComposeLogFollowerPids(
  processList: string,
  config: CanvasCliConfig,
  serviceName: string,
): number[] {
  const pids: number[] = [];
  for (const line of processList.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match || Number(match[2]) !== 1) continue;
    const command = match[3];
    const tokens = command.split(/\s+/u);
    const composeCommand = /(?:^|\s)docker(?:-compose|\s+compose)(?:\s|$)/u.test(command);
    const logsIndex = tokens.indexOf('logs');
    const followingLogs = logsIndex >= 0 && tokens.slice(logsIndex + 1).some((token) => token === '-f' || token === '--follow');
    if (!composeCommand || !followingLogs) continue;
    if (!command.includes(config.paths.composeFile) || !command.includes(config.paths.installDir)) continue;
    if (!tokens.includes(serviceName)) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) pids.push(pid);
  }
  return [...new Set(pids)];
}

export async function cleanupOrphanedLogFollowers(params: {
  runner: CommandRunner;
  context: RuntimeContext;
  config: CanvasCliConfig;
}): Promise<number[]> {
  if (params.context.platform === 'windows') return [];
  const result = await params.runner.run('ps', ['-axo', 'pid=,ppid=,command=']).catch(() => null);
  if (!result || result.status !== 0) return [];
  const pids = orphanedComposeLogFollowerPids(result.stdout, params.config, params.context.serviceName);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return pids;
}
