import type { CommandResult, CommandRunner, RunOptions } from './types';
import { startManagedProcess } from './processLifecycle';

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
      const managed = startManagedProcess(command, args, { ...options, stdio });
      const { child } = managed;

      const stdout: CapturedOutput = { chunks: [], byteLength: 0, truncated: false };
      const stderr: CapturedOutput = { chunks: [], byteLength: 0, truncated: false };
      let captureExceeded = false;
      const outputLimit = Math.min(MAX_CAPTURED_PROCESS_OUTPUT_BYTES, options.maxOutputBytes ?? MAX_CAPTURED_PROCESS_OUTPUT_BYTES);
      if (!Number.isInteger(outputLimit) || outputLimit <= OUTPUT_TRUNCATION_NOTICE.length) {
        managed.stop();
        managed.completion.catch(() => undefined);
        reject(new Error('Invalid process output limit.'));
        return;
      }
      const capture = (state: CapturedOutput, chunk: Buffer) => {
        appendCapturedOutput(state, chunk);
        if (state.byteLength > outputLimit || state.truncated) {
          if (options.capture === 'exact') {
            captureExceeded = true;
            managed.stop();
          }
          state.truncated = true;
          trimCapturedOutput(state, outputLimit - OUTPUT_TRUNCATION_NOTICE.length);
        }
      };

      if (stdio === 'pipe') {
        child.stdout?.on('data', (chunk) => {
          capture(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        });
        child.stderr?.on('data', (chunk) => {
          capture(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        });
      }

      managed.completion.then(({ code, signal, timedOut, canceled, error }) => {
        if (captureExceeded) capture(stderr, Buffer.from('\nStructured process output exceeded its limit.', 'utf8'));
        if (error) capture(stderr, Buffer.from(`\nProcess stream failed: ${(error as NodeJS.ErrnoException).code || error.name}.`, 'utf8'));
        if (timedOut) {
          capture(stderr, Buffer.from('\nCommand exceeded its update deadline.', 'utf8'));
        } else if (signal) {
          capture(stderr, Buffer.from(`\nCommand terminated by ${signal}.`, 'utf8'));
        }
        resolve({
          status: timedOut ? 124 : (captureExceeded || canceled ? 1 : (code ?? 1)),
          stdout: capturedOutputText(stdout),
          stderr: timedOut ? capturedOutputText(stderr).trim() : capturedOutputText(stderr),
          signal, timedOut, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
        });
      }, reject);

      if (options.stdin !== undefined) {
        child.stdin?.end(options.stdin);
      } else if (stdio === 'pipe') {
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
