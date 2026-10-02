import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';

import type { AgentBlockStructure } from '../../app/lib/collaboration/agent-block-structure';
import { runLocalAgentTool } from './local-agent-tool-client';

const execFileAsync = promisify(execFile);
const HARNESS_FAILURE = 'The explicit local in-process tool harness is required.';

type QaHostReceipt = {
  version: 1; pid: number; port: number; bindingHash: string; startedAt: number; processStartIdentity: string;
};

export async function requireOwnedQaAgentToolSocket(socketPath: string): Promise<void> {
  try {
    const { requireOwnedCollaborationQaTarget } = await import('../../scripts/lib/owned-collaboration-qa');
    const target = await requireOwnedCollaborationQaTarget();
    const uid = process.getuid?.();
    const directory = path.dirname(socketPath);
    if (uid === undefined || !path.isAbsolute(socketPath) || path.basename(socketPath) !== 'tools.sock'
      || path.dirname(directory) !== '/tmp' || !/^canvas-agent-qa-e2e-[A-Za-z0-9]+$/u.test(path.basename(directory))) {
      throw new Error(HARNESS_FAILURE);
    }
    const [dir, socket, physicalDirectory, physicalTmp] = await Promise.all([
      lstat(directory), lstat(socketPath), realpath(directory), realpath('/tmp'),
    ]);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o777) !== 0o700
      || physicalDirectory !== path.join(physicalTmp, path.basename(directory))
      || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) {
      throw new Error(HARNESS_FAILURE);
    }
    const receiptFile = await open(path.join(directory, 'host-binding.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let receipt: QaHostReceipt;
    try {
      const before = await receiptFile.stat();
      if (!before.isFile() || before.uid !== uid || (before.mode & 0o777) !== 0o600 || before.size > 4096) {
        throw new Error(HARNESS_FAILURE);
      }
      receipt = JSON.parse(await receiptFile.readFile('utf8')) as QaHostReceipt;
      const after = await receiptFile.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(HARNESS_FAILURE);
      }
    } finally { await receiptFile.close(); }
    if (receipt.version !== 1 || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0
      || receipt.port !== target.port || receipt.bindingHash !== target.bindingHash
      || !Number.isSafeInteger(receipt.startedAt) || receipt.startedAt <= 0 || receipt.startedAt > Date.now()
      || typeof receipt.processStartIdentity !== 'string' || receipt.processStartIdentity.length > 128) {
      throw new Error(HARNESS_FAILURE);
    }
    process.kill(receipt.pid, 0);
    const identity = (await execFileAsync('/bin/ps', ['-p', String(receipt.pid), '-o', 'uid=', '-o', 'lstart='],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 4096 })).stdout.trim().replace(/\s+/gu, ' ');
    const processStartedAt = Date.parse(identity.slice(identity.indexOf(' ') + 1));
    if (identity !== receipt.processStartIdentity || !identity.startsWith(`${uid} `)
      || !Number.isFinite(processStartedAt) || processStartedAt > receipt.startedAt) {
      throw new Error(HARNESS_FAILURE);
    }
    const currentSocket = await lstat(socketPath);
    if (currentSocket.dev !== socket.dev || currentSocket.ino !== socket.ino
      || currentSocket.uid !== uid || (currentSocket.mode & 0o777) !== 0o600) throw new Error(HARNESS_FAILURE);
  } catch { throw new Error(HARNESS_FAILURE); }
}

export type OrdinaryAgentToolDetails = {
  sha256?: string;
  afterSha256?: string;
  code?: string;
  outcome?: string;
  editIndex?: number;
  proposal?: { proposalId: string; operationId: string; creationKind: string; source: { kind: string } };
  document?: { documentId: string; lifecycleGeneration: number; schemaVersion: number };
  structure?: { blocks: AgentBlockStructure[]; nextOffset: number | null; totalBlocks: number };
  collaboration?: {
    operationId?: string; operationStatus?: string; durability?: string; reviewRequired?: boolean;
    documentId?: string; lifecycleGeneration?: number; schemaVersion?: number;
    representation?: string; source?: string;
  };
};

type OrdinaryAgentToolResult = {
  isError?: boolean;
  details?: OrdinaryAgentToolDetails & { results?: OrdinaryAgentToolDetails[] };
};

export async function runOrdinaryAgentTool(input: {
  toolName: 'read' | 'write' | 'edit_file' | 'apply_patch'; toolCallId: string;
  params: Record<string, unknown>; context: Record<string, unknown>;
}, options?: { graphMode?: 'off'; inProcess?: boolean }): Promise<OrdinaryAgentToolResult> {
  if (options?.inProcess) {
    const socketPath = process.env.CANVAS_LOCAL_AGENT_TOOL_SOCKET;
    if (!socketPath || options.graphMode || process.env.COLLABORATION_E2E !== '1') {
      throw new Error(HARNESS_FAILURE);
    }
    if (process.env.NODE_ENV === 'production') await requireOwnedQaAgentToolSocket(socketPath);
    else if (process.env.NODE_ENV !== 'development') throw new Error(HARNESS_FAILURE);
    return await runLocalAgentTool(input, socketPath) as OrdinaryAgentToolResult;
  }
  let stdout: string;
  try {
    const result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'),
      ['--conditions', 'react-server', 'scripts/collaboration-agent-tool-driver.ts',
        Buffer.from(JSON.stringify(input)).toString('base64url')],
      { cwd: process.cwd(), env: options?.graphMode ? { ...process.env, CANVAS_PROPOSAL_GRAPH_MODE: options.graphMode } : process.env,
        maxBuffer: 2 * 1024 * 1024, timeout: 60_000 });
    stdout = result.stdout;
  } catch {
    // Command arguments contain the scoped agent context; never put them or
    // stderr into a browser report. The test's own fixture is the sole target.
    throw new Error('The ordinary agent tool driver failed; no command arguments or stderr were included.');
  }
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const result = JSON.parse(line) as OrdinaryAgentToolResult;
      if (result.details) return result;
    } catch { /* Structured runtime observations can precede the final result. */ }
  }
  throw new Error('The ordinary tool returned no structured result.');
}
