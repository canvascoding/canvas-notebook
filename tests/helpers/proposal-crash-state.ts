import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProposalCrashState = {
  canonicalContent: string;
  binaryHash: string;
  stateProof: string;
  documentSequence: number;
  degraded: boolean;
  receipt: { status: string; snapshotHash: string | null; resultHash: string | null } | null;
};

/** Independent read-only PG evidence, including while the owned app is dead. */
export async function readProposalCrashState(input: {
  documentId: string; workspaceId: string; path: string; operationId?: string;
}): Promise<ProposalCrashState> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(path.resolve('node_modules/.bin/tsx'), ['--conditions', 'react-server',
      'scripts/collaboration-e2e-storage-read.ts',
      Buffer.from(JSON.stringify({ ...input, includeGraphProof: true })).toString('base64url')],
    { env: process.env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }));
  } catch { throw new Error('Scoped persisted crash evidence was unavailable.'); }
  return JSON.parse(stdout) as ProposalCrashState;
}
