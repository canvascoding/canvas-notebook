import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function seedanceMediaFixture(kind: 'image' | 'video' | 'audio', duration = 2): { imageBytes: string; mimeType: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'seedance-fixture-'));
  const filename = path.join(directory, kind === 'image' ? 'image.png' : kind === 'video' ? 'video.mp4' : 'audio.wav');
  try {
    const args = kind === 'audio'
      ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', String(duration)]
      : ['-f', 'lavfi', '-i', 'color=c=blue:s=640x640:r=24', ...(kind === 'image' ? ['-frames:v', '1'] : ['-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'])];
    execFileSync('ffmpeg', ['-v', 'error', ...args, filename]);
    return { imageBytes: readFileSync(filename).toString('base64'), mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/wav' };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
