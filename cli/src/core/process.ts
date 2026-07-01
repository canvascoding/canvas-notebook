import { spawn } from 'node:child_process';

import type { CommandResult, CommandRunner, RunOptions } from './types';

export class SpawnCommandRunner implements CommandRunner {
  run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const stdio = options.stdio === 'inherit' ? 'inherit' : 'pipe';
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      if (stdio === 'pipe') {
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on('data', (chunk) => {
          stderr += String(chunk);
        });
      }

      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          status: code ?? 0,
          stdout,
          stderr,
        });
      });

      if (options.stdin !== undefined) {
        child.stdin?.write(options.stdin);
        child.stdin?.end();
      }
    });
  }
}

export async function runOrThrow(
  runner: CommandRunner,
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const result = await runner.run(command, args, options);
  if (result.status !== 0) {
    const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
    throw new Error(output || `${command} ${args.join(' ')} exited with ${result.status}`);
  }
  return result;
}
