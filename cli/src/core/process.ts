import { spawn } from 'node:child_process';

import type { CommandResult, CommandRunner, RunOptions } from './types';

export const MAX_CAPTURED_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;

const OUTPUT_TRUNCATION_NOTICE = Buffer.from('[... process output truncated; showing tail ...]\n', 'utf8');

interface CapturedOutput {
  chunks: Buffer[];
  byteLength: number;
  truncated: boolean;
}

function trimCapturedOutput(state: CapturedOutput, limit: number): void {
  while (state.byteLength > limit) {
    const first = state.chunks[0];
    if (!first) {
      state.byteLength = 0;
      return;
    }

    const excess = state.byteLength - limit;
    if (first.length <= excess) {
      state.chunks.shift();
      state.byteLength -= first.length;
      continue;
    }

    state.chunks[0] = Buffer.from(first.subarray(excess));
    state.byteLength -= excess;
  }
}

function appendCapturedOutput(state: CapturedOutput, chunk: Buffer): void {
  state.chunks.push(chunk);
  state.byteLength += chunk.length;
  const tailLimit = MAX_CAPTURED_PROCESS_OUTPUT_BYTES - OUTPUT_TRUNCATION_NOTICE.length;
  if (!state.truncated && state.byteLength > MAX_CAPTURED_PROCESS_OUTPUT_BYTES) {
    state.truncated = true;
  }
  trimCapturedOutput(state, state.truncated ? tailLimit : MAX_CAPTURED_PROCESS_OUTPUT_BYTES);
}

function capturedOutputText(state: CapturedOutput): string {
  const chunks = state.truncated
    ? [OUTPUT_TRUNCATION_NOTICE, ...state.chunks]
    : state.chunks;
  const byteLength = state.byteLength + (state.truncated ? OUTPUT_TRUNCATION_NOTICE.length : 0);
  return Buffer.concat(chunks, byteLength).toString('utf8');
}

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

      const stdout: CapturedOutput = { chunks: [], byteLength: 0, truncated: false };
      const stderr: CapturedOutput = { chunks: [], byteLength: 0, truncated: false };
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const timeout = options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
          forceKillTimer.unref();
        }, options.timeoutMs)
        : undefined;
      timeout?.unref();

      if (stdio === 'pipe') {
        child.stdout?.on('data', (chunk) => {
          appendCapturedOutput(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        });
        child.stderr?.on('data', (chunk) => {
          appendCapturedOutput(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        });
      }

      child.on('error', reject);
      child.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (timedOut) {
          appendCapturedOutput(stderr, Buffer.from('\nCommand exceeded its update deadline.', 'utf8'));
        }
        resolve({
          status: timedOut ? 124 : (code ?? 0),
          stdout: capturedOutputText(stdout),
          stderr: timedOut ? capturedOutputText(stderr).trim() : capturedOutputText(stderr),
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
