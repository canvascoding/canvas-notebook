import 'server-only';

import { promises as fs } from 'node:fs';
import os from 'node:os';

import type { BrowserViewResourceBudget } from './types';

const MIB = 1024 * 1024;
const MIN_EFFECTIVE_MEMORY_MB = 1536;

async function readNumericFile(filePath: string): Promise<number | null> {
  try {
    const raw = (await fs.readFile(filePath, 'utf8')).trim();
    if (!raw || raw === 'max') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function readCgroupMemory(): Promise<{ limitBytes: number | null; availableBytes: number | null }> {
  const [v2Limit, v2Current] = await Promise.all([
    readNumericFile('/sys/fs/cgroup/memory.max'),
    readNumericFile('/sys/fs/cgroup/memory.current'),
  ]);
  if (v2Limit) {
    return {
      limitBytes: v2Limit,
      availableBytes: v2Current === null ? null : Math.max(0, v2Limit - v2Current),
    };
  }

  const [v1Limit, v1Current] = await Promise.all([
    readNumericFile('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    readNumericFile('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
  ]);
  return {
    limitBytes: v1Limit,
    availableBytes: v1Limit && v1Current !== null ? Math.max(0, v1Limit - v1Current) : null,
  };
}

export async function resolveBrowserViewResourceBudget(): Promise<BrowserViewResourceBudget> {
  const cgroup = await readCgroupMemory();
  const hostTotalBytes = os.totalmem();
  const hostAvailableBytes = os.freemem();
  const effectiveBytes = cgroup.limitBytes
    ? Math.min(hostTotalBytes, cgroup.limitBytes)
    : hostTotalBytes;
  const availableBytes = cgroup.availableBytes === null
    ? hostAvailableBytes
    : Math.min(hostAvailableBytes, cgroup.availableBytes);
  const effectiveMemoryMb = Math.floor(effectiveBytes / MIB);
  const availableMemoryMb = Math.floor(availableBytes / MIB);
  const allowed = effectiveMemoryMb >= MIN_EFFECTIVE_MEMORY_MB;
  const constrained = effectiveMemoryMb < 4096;

  return {
    allowed,
    effectiveMemoryMb,
    availableMemoryMb,
    fps: constrained ? 3 : 6,
    viewport: constrained ? { width: 1152, height: 720 } : { width: 1280, height: 800 },
    jpegQuality: constrained ? 55 : 65,
    maxConcurrentViews: constrained ? 1 : effectiveMemoryMb >= 8192 ? 4 : 2,
    reason: allowed
      ? null
      : `Interactive browser views require at least ${MIN_EFFECTIVE_MEMORY_MB} MiB effective memory.`,
  };
}
