import 'server-only';

import { execFile, spawn } from 'node:child_process';
import { TranscriptionServiceError } from './errors';

const SAMPLE_RATE = 16_000;
const MAX_PCM_BYTES = 6 * 60 * SAMPLE_RATE * 2;
let readiness: { checkedAt: number; available: boolean } | undefined;

export async function wisprAudioConversionAvailable(): Promise<boolean> {
  if (readiness && Date.now() - readiness.checkedAt < 60_000) return readiness.available;
  const available = await new Promise<boolean>(resolve => {
    execFile('ffmpeg', ['-version'], { timeout: 2_000, maxBuffer: 64 * 1024 }, error => resolve(!error));
  });
  readiness = { checkedAt: Date.now(), available };
  return available;
}

/** Decode locally; block external protocols and bound CPU time, duration and output. */
export async function convertWisprAudio(buffer: Buffer, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-threads', '1',
      '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-map', '0:a:0', '-vn',
      '-t', '361', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let force: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGTERM');
      force ??= setTimeout(() => child.kill('SIGKILL'), 1_000);
      force.unref();
    };
    const abort = () => stop(new DOMException('Audio conversion was cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', () => {
      failure ??= new TranscriptionServiceError('Wispr requires FFmpeg on the server to convert recordings.', 'AUDIO_CONVERSION_UNAVAILABLE', 503);
    });
    child.stdin.on('error', () => { /* close owns completion, including decode failures */ });
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PCM_BYTES) {
        stop(new TranscriptionServiceError('Wispr recordings must be at most six minutes long.', 'AUDIO_TOO_LONG', 413));
      } else if (!failure) chunks.push(chunk);
    });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (force) clearTimeout(force);
      if (failure) reject(failure);
      else if (code !== 0 || !size) reject(new TranscriptionServiceError('The recording could not be decoded for Wispr.', 'INVALID_AUDIO', 400));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(buffer);
  });
  signal.throwIfAborted();
  // Raw PCM avoids the unknown length headers of a WAV streamed through a pipe.
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
