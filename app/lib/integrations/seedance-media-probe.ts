import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export type SeedanceMediaInput = { imageBytes: string; mimeType: string };
export type SeedanceMediaFacts = { durationSeconds: number; width: number; height: number; fps: number };

export async function inspectSeedanceMedia(reference: SeedanceMediaInput): Promise<SeedanceMediaFacts> {
  const directory = await mkdtemp(path.join(tmpdir(), 'canvas-seedance-probe-'));
  try {
    const file = path.join(directory, 'input');
    await writeFile(file, Buffer.from(reference.imageBytes.replace(/^data:[^,]*,/, ''), 'base64'), { mode: 0o600 });
    const { stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', 'mov,matroska,webm,mp3,wav,aac,ogg,image2,png_pipe,jpeg_pipe,webp_pipe',
      '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,duration', '-of', 'json', file,
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }> };
    const kind = reference.mimeType.startsWith('audio/') ? 'audio' : 'video';
    const stream = data.streams?.find((item) => item.codec_type === kind);
    if (!stream) throw new Error('Missing media stream');
    const [numerator, denominator] = (stream.avg_frame_rate || '0/1').split('/').map(Number);
    return { durationSeconds: Number(stream.duration || data.format?.duration || 0), width: stream.width || 0, height: stream.height || 0, fps: numerator / (denominator || 1) };
  } catch {
    throw new Error('Seedance reference could not be inspected. Use a readable supported media file; ffprobe must be available on the server.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function validateSeedanceReferenceContent(references: SeedanceMediaInput[]): Promise<{ videoDurationSeconds: number; audioDurationSeconds: number }> {
  const cache = new Map<string, SeedanceMediaFacts>();
  let videoDurationSeconds = 0;
  let audioDurationSeconds = 0;
  for (const reference of references) {
    const key = createHash('sha256').update(reference.mimeType).update(reference.imageBytes).digest('hex');
    let facts = cache.get(key);
    if (!facts) { facts = await inspectSeedanceMedia(reference); cache.set(key, facts); }
    const kind = reference.mimeType.split('/')[0];
    const { width, height, durationSeconds, fps } = facts;
    if (kind === 'image' || kind === 'video') {
      const ratio = width / height;
      const validDimensions = kind === 'image'
        ? width > 300 && height > 300 && width < 6000 && height < 6000 && ratio > 0.4 && ratio < 2.5
        : width >= 300 && height >= 300 && width <= 6000 && height <= 6000 && ratio >= 0.4 && ratio <= 2.5;
      if (!validDimensions) throw new Error('Seedance reference dimensions or aspect ratio are outside the supported range (300–6000 px, 0.4–2.5 aspect ratio; image bounds exclusive).');
    }
    if (kind === 'video') {
      if (width * height < 409600 || width * height > 927408 || fps < 24 || fps > 60) throw new Error('Seedance reference video requires 409600–927408 pixels and 24–60 FPS.');
      videoDurationSeconds += durationSeconds;
    }
    if (kind === 'audio') audioDurationSeconds += durationSeconds;
    if ((kind === 'audio' || kind === 'video') && (!Number.isFinite(durationSeconds) || durationSeconds < 2 || durationSeconds > 30)) throw new Error('Seedance reference video/audio duration must be 2–30 seconds.');
  }
  if (videoDurationSeconds > 30.001 || audioDurationSeconds > 30.001) throw new Error('Seedance reference videos and reference audio may each total at most 30 seconds.');
  return { videoDurationSeconds, audioDurationSeconds };
}
