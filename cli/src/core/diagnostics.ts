import fs from 'node:fs/promises';
import os from 'node:os';

export interface HostResourceSnapshot {
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  diskTotalBytes: number;
  diskAvailableBytes: number;
  uptimeSeconds: number;
  loadAverage: number[];
}

export async function collectHostResources(diskPath: string): Promise<HostResourceSnapshot> {
  const disk = await fs.statfs(diskPath).catch(() => null);
  return {
    memoryTotalBytes: os.totalmem(),
    memoryAvailableBytes: os.freemem(),
    diskTotalBytes: disk ? Number(disk.blocks) * Number(disk.bsize) : 0,
    diskAvailableBytes: disk ? Number(disk.bavail) * Number(disk.bsize) : 0,
    uptimeSeconds: os.uptime(),
    loadAverage: os.loadavg(),
  };
}
