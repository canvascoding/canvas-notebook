import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { readNativeStorageDeviceMap } from '../files/native-storage-device-map';
import { resolveCanvasDataRoot } from '../runtime-data-paths';

const markers = [
  { name: 'canvas-markdown-create-births-anchor.json', identity: 'data', versions: [1, 2] },
  { name: 'canvas-markdown-upload-attempts-anchor.json', identity: 'root', versions: [1] },
  { name: 'canvas-upload-live-anchor.json', identity: 'root', versions: [1] },
] as const;

/**
 * Check the root binding of existing native storage markers without creating
 * storage or taking write locks. Individual operations still verify their own
 * complete authority. Fresh installations may not have any markers yet.
 */
export async function nativeStorageAnchorRootsMatch(dataRoot = resolveCanvasDataRoot()): Promise<boolean> {
  try {
    const directory = await fs.open(dataRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const root = await directory.stat({ bigint: true });
      const binding = await readNativeStorageDeviceMap(directory);
      const expectedDevice = binding?.recordedDevice ?? String(root.dev);
      const rootPath = process.platform === 'linux' ? `/proc/self/fd/${directory.fd}` : dataRoot;
      for (const marker of markers) {
        const filename = path.join(rootPath, marker.name);
        const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
        if (!handle) continue;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > 4096) return false;
          const buffer = Buffer.alloc(4097);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead !== stat.size) return false;
          const value = JSON.parse(buffer.toString('utf8', 0, bytesRead));
          const identity = value?.[marker.identity];
          if (!(marker.versions as readonly number[]).includes(value?.version)
            || identity?.dev !== expectedDevice || identity?.ino !== String(root.ino)
            || identity?.uid !== Number(root.uid) || identity?.mode !== Number(root.mode & BigInt(0o7777))) return false;
        } finally {
          await handle.close();
        }
      }
      const named = await fs.lstat(dataRoot, { bigint: true });
      return named.isDirectory() && named.dev === root.dev && named.ino === root.ino
        && named.uid === root.uid && named.mode === root.mode;
    } finally {
      await directory.close();
    }
  } catch {
    return false;
  }
}
