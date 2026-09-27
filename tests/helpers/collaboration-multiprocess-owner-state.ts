import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CollaborationMultiprocessOwnerState = Readonly<{
  epoch: number;
  tokenHash: string | null;
  backendPid: number | null;
  backendStart: string | null;
  lockHeld: boolean;
  activities: ReadonlyArray<Readonly<{
    pid: number;
    applicationName: string;
    backendStart: string;
  }>>;
}>;

export async function readCollaborationMultiprocessOwnerState(input: {
  documentId: string;
  workspaceId: string;
  path: string;
}): Promise<CollaborationMultiprocessOwnerState> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(path.resolve('node_modules/.bin/tsx'), [
      '--conditions', 'react-server', 'scripts/collaboration-multiprocess-owner-read.ts',
      Buffer.from(JSON.stringify(input)).toString('base64url'),
    ], { env: process.env, timeout: 30_000, maxBuffer: 1024 * 1024 }));
  } catch {
    throw new Error('Scoped multi-process room-owner evidence was unavailable.');
  }
  return JSON.parse(stdout) as CollaborationMultiprocessOwnerState;
}
