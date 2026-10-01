import { spawn } from 'node:child_process';
import { superviseProcess } from './processLifecycle';

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
      options.signal?.throwIfAborted();
      const stdio = options.stdio === 'inherit' ? 'inherit' : 'pipe';
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio,
        windowsHide: true,
        detached: options.processGroup && process.platform !== 'win32',
      });

      const stdout: CapturedOutput = { chunks: [], byteLength: 0, truncated: false };
      const stderr: CapturedOutput = { chunks: [], byteLength: 0, truncated: false };
      const lifecycle = superviseProcess(child, options);

      if (stdio === 'pipe') {
        child.stdout?.on('data', (chunk) => {
          appendCapturedOutput(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        });
        child.stderr?.on('data', (chunk) => {
          appendCapturedOutput(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        });
      }

      child.on('error', reject);
      child.on('close', async (code, signal) => {
        await lifecycle.completion;
        if (lifecycle.timedOut) {
          appendCapturedOutput(stderr, Buffer.from('\nCommand exceeded its update deadline.', 'utf8'));
        } else if (lifecycle.aborted) {
          appendCapturedOutput(stderr, Buffer.from('\nCommand was canceled.', 'utf8'));
        } else if (signal) {
          appendCapturedOutput(stderr, Buffer.from(`\nCommand terminated by ${signal}.`, 'utf8'));
        }
        resolve({
          status: lifecycle.timedOut ? 124 : lifecycle.aborted ? 130 : (code ?? 1),
          stdout: capturedOutputText(stdout),
          stderr: lifecycle.timedOut || lifecycle.aborted ? capturedOutputText(stderr).trim() : capturedOutputText(stderr),
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
