import 'server-only';

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inlineMarpMarkdownWorkspaceAssets } from './render';

export const MARP_EXPORT_TIMEOUT_MS = 60_000;

export function getMarpCliPath() {
  return path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'marp.cmd' : 'marp');
}

export function runMarpCli(args: string[], cwd: string, timeoutMs = MARP_EXPORT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(getMarpCliPath(), args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('MARP_EXPORT_TIMEOUT'));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `Marp CLI exited with code ${code}`));
    });
  });
}

export function getMarpExportBaseName(filePath: string) {
  const baseName = path
    .basename(filePath)
    .replace(/\.(marp|slides)\.(md|markdown)$/i, '')
    .replace(/\.(md|markdown)$/i, '');

  return baseName || 'slides';
}

export async function writeMarpCliInput(
  options: {
    tempDir: string;
    filePath: string;
    markdown: string;
  }
) {
  const markdown = await inlineMarpMarkdownWorkspaceAssets(options.markdown, {
    filePath: options.filePath,
  });
  const inputPath = path.join(options.tempDir, 'deck.md');

  await fs.writeFile(inputPath, markdown, 'utf-8');

  return inputPath;
}
