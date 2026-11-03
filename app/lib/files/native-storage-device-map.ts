import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export type NativeStorageDeviceMap = Readonly<{ recordedDevice: string; currentDevice: string }>;

export async function readNativeStorageDeviceMap(root: FileHandle): Promise<NativeStorageDeviceMap | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    await fs.lstat(`/proc/self/fd/${root.fd}/canvas-native-storage-binding.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const helper = path.join(process.env.CANVAS_APP_ROOT?.trim() || process.cwd(), 'scripts/runtime/native-storage-witness.py');
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3', ['-I', helper, '--device-map-fd'], {
      stdio: ['ignore', 'pipe', 'ignore', root.fd],
    });
    let output = '';
    let failed = false;
    const stop = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, 3000);
    child.on('error', () => { failed = true; });
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      if (output.length + chunk.length > 512) stop();
      else output += chunk;
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error('Native storage binding verification failed.'));
      else resolve(output);
    });
  });
  const value = JSON.parse(raw) as Partial<NativeStorageDeviceMap> | null;
  const validDevice = (device: unknown): device is string =>
    typeof device === 'string' && /^(?:0|[1-9][0-9]{0,19})$/u.test(device) && BigInt(device) < 2n ** 64n;
  if (!value || Object.keys(value).length !== 2 || !validDevice(value.currentDevice) || !validDevice(value.recordedDevice)
    || value.currentDevice !== (await root.stat({ bigint: true })).dev.toString()) {
    throw new Error('Native storage binding changed during verification.');
  }
  return value.currentDevice === value.recordedDevice ? undefined
    : Object.freeze({ currentDevice: value.currentDevice, recordedDevice: value.recordedDevice });
}
