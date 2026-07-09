import 'server-only';

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildLimitedBrowserExportCommand,
  DEFAULT_MARP_BROWSER_EXPORT_TIMEOUT_MS,
  runBrowserExportJob,
} from '@/app/lib/exports/browser-export-service';
import { inlineMarpMarkdownWorkspaceAssets } from './render';
import type { WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';

export const MARP_EXPORT_TIMEOUT_MS = DEFAULT_MARP_BROWSER_EXPORT_TIMEOUT_MS;

export function getMarpCliPath() {
  return path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'marp.cmd' : 'marp');
}

export function runMarpCli(args: string[], cwd: string, timeoutMs = MARP_EXPORT_TIMEOUT_MS): Promise<void> {
  let child: ChildProcess | null = null;

  return runBrowserExportJob({
    label: 'marp-export',
    timeoutMs,
    timeoutErrorMessage: 'MARP_EXPORT_TIMEOUT',
    onTimeout: () => {
      if (child && child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    },
    run: () => new Promise((resolve, reject) => {
      const commandSpec = buildLimitedBrowserExportCommand(getMarpCliPath(), args, { timeoutMs });
      child = spawn(commandSpec.command, commandSpec.args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.trim() || `Marp CLI exited with code ${code}`));
      });
    }),
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
    fileOptions?: WorkspaceFileOperationOptions;
  }
) {
  const markdown = await inlineMarpMarkdownWorkspaceAssets(options.markdown, {
    filePath: options.filePath,
    fileOptions: options.fileOptions,
  });
  const inputPath = path.join(options.tempDir, 'deck.md');

  await fs.writeFile(inputPath, markdown, 'utf-8');

  return inputPath;
}
