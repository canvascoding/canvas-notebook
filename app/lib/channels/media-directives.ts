import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStudioOutputsRoot } from '@/app/lib/integrations/studio-workspace';
import {
  getUserUploadsRoot,
  resolveAgentStorageDir,
  resolveAgentsStorageRoot,
  resolveCanvasDataRoot,
  resolveSecretsDir,
} from '@/app/lib/runtime-data-paths';
import { getWorkspacePath } from '@/app/lib/utils/workspace-manager';

export type ParsedMediaDirective = {
  rawPath: string;
};

export type ParsedMediaDirectives = {
  text: string;
  media: ParsedMediaDirective[];
  audioAsVoice: boolean;
  asDocument: boolean;
  hadDirective: boolean;
};

export type SafeMediaAttachment = {
  rawPath: string;
  path: string;
  size: number;
};

export type UnsafeMediaDirective = {
  rawPath: string;
  reason: string;
};

const AUDIO_AS_VOICE_TAG_PATTERN = /\[\[\s*audio_as_voice\s*\]\]/gi;
const AS_DOCUMENT_TAG_PATTERN = /\[\[\s*as_document\s*\]\]/gi;
const MEDIA_LINE_PATTERN = /^\s*MEDIA\s*:\s*(.+?)\s*$/i;
const MAX_MEDIA_PATH_LENGTH = 4096;

const DENIED_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'canvas-integrations.env',
  'canvas-agents.env',
  'auth.json',
  'credentials',
]);

const DENIED_PATH_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.azure',
  '.gcloud',
  'secrets',
]);

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed[trimmed.length - 1] && ['"', "'", '`'].includes(trimmed[0])) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.replace(/^[`"']+/, '').replace(/[`"',.;:)}\]]+$/, '').trim();
}

function normalizeCandidatePath(rawPath: string): string | null {
  const stripped = stripWrappingQuotes(rawPath);
  if (!stripped || stripped.length > MAX_MEDIA_PATH_LENGTH) {
    return null;
  }

  if (stripped.startsWith('file://')) {
    try {
      return fileURLToPath(stripped);
    } catch {
      return null;
    }
  }

  return stripped;
}

function isPathWithin(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    const normalized = path.resolve(root);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

async function resolveExistingRoot(root: string): Promise<string | null> {
  try {
    return await fs.realpath(root);
  } catch {
    return path.resolve(root);
  }
}

async function getAllowedMediaRoots(): Promise<string[]> {
  const dataRoot = resolveCanvasDataRoot();
  const roots = uniqueRoots([
    getUserUploadsRoot(),
    getStudioOutputsRoot(),
    getWorkspacePath(),
    path.join(dataRoot, 'workspace'),
  ]);

  const resolved = await Promise.all(roots.map(resolveExistingRoot));
  return uniqueRoots(resolved.filter((root): root is string => Boolean(root)));
}

async function getDeniedMediaRoots(): Promise<string[]> {
  const dataRoot = resolveCanvasDataRoot();
  const roots = uniqueRoots([
    resolveSecretsDir(),
    resolveAgentStorageDir(),
    resolveAgentsStorageRoot(),
    path.join(dataRoot, 'secrets'),
    path.join(dataRoot, 'canvas-agent'),
    path.join(dataRoot, 'agents'),
  ]);

  const resolved = await Promise.all(roots.map(resolveExistingRoot));
  return uniqueRoots(resolved.filter((root): root is string => Boolean(root)));
}

function hasDeniedNameOrSegment(resolvedPath: string): boolean {
  const parsed = path.parse(resolvedPath);
  if (DENIED_BASENAMES.has(parsed.base.toLowerCase())) {
    return true;
  }

  return resolvedPath
    .split(path.sep)
    .some((segment) => DENIED_PATH_SEGMENTS.has(segment.toLowerCase()));
}

export function parseMediaDirectives(rawText: string): ParsedMediaDirectives {
  const input = String(rawText || '');
  const media: ParsedMediaDirective[] = [];
  const audioAsVoice = AUDIO_AS_VOICE_TAG_PATTERN.test(input);
  AUDIO_AS_VOICE_TAG_PATTERN.lastIndex = 0;
  const asDocument = AS_DOCUMENT_TAG_PATTERN.test(input);
  AS_DOCUMENT_TAG_PATTERN.lastIndex = 0;

  const lines = input.split(/\r?\n/);
  const keptLines: string[] = [];
  let inFencedCodeBlock = false;
  let foundMediaDirective = false;

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFencedCodeBlock = !inFencedCodeBlock;
      keptLines.push(line);
      continue;
    }

    if (!inFencedCodeBlock) {
      const mediaMatch = line.match(MEDIA_LINE_PATTERN);
      if (mediaMatch) {
        const rawPath = stripWrappingQuotes(mediaMatch[1]);
        if (rawPath) {
          media.push({ rawPath });
        }
        foundMediaDirective = true;
        continue;
      }
    }

    keptLines.push(line);
  }

  const text = keptLines
    .join('\n')
    .replace(AUDIO_AS_VOICE_TAG_PATTERN, '')
    .replace(AS_DOCUMENT_TAG_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text,
    media,
    audioAsVoice,
    asDocument,
    hadDirective: foundMediaDirective || audioAsVoice || asDocument,
  };
}

export async function validateMediaDirectivePath(
  rawPath: string,
  options: { maxBytes?: number } = {},
): Promise<SafeMediaAttachment | UnsafeMediaDirective> {
  const candidate = normalizeCandidatePath(rawPath);
  if (!candidate) {
    return { rawPath, reason: 'invalid_path' };
  }

  if (!path.isAbsolute(candidate)) {
    return { rawPath, reason: 'path_must_be_absolute' };
  }

  let resolvedPath: string;
  let stats;
  try {
    resolvedPath = await fs.realpath(candidate);
    stats = await fs.stat(resolvedPath);
  } catch {
    return { rawPath, reason: 'file_not_found' };
  }

  if (!stats.isFile()) {
    return { rawPath, reason: 'not_a_file' };
  }

  const deniedRoots = await getDeniedMediaRoots();
  if (deniedRoots.some((root) => isPathWithin(resolvedPath, root)) || hasDeniedNameOrSegment(resolvedPath)) {
    return { rawPath, reason: 'denied_path' };
  }

  const allowedRoots = await getAllowedMediaRoots();
  if (!allowedRoots.some((root) => isPathWithin(resolvedPath, root))) {
    return { rawPath, reason: 'outside_allowed_roots' };
  }

  if (options.maxBytes && stats.size > options.maxBytes) {
    return { rawPath, reason: 'file_too_large' };
  }

  return {
    rawPath,
    path: resolvedPath,
    size: stats.size,
  };
}

export function isSafeMediaAttachment(
  value: SafeMediaAttachment | UnsafeMediaDirective,
): value is SafeMediaAttachment {
  return 'path' in value;
}
