import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AgentBlockStructure } from '../../app/lib/collaboration/agent-block-structure';

const execFileAsync = promisify(execFile);

export type OrdinaryAgentToolDetails = {
  sha256?: string;
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
}, options?: { graphMode: 'off' }): Promise<OrdinaryAgentToolResult> {
  let stdout: string;
  try {
    const result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'),
      ['--conditions', 'react-server', 'scripts/collaboration-agent-tool-driver.ts',
        Buffer.from(JSON.stringify(input)).toString('base64url')],
      { cwd: process.cwd(), env: options ? { ...process.env, CANVAS_PROPOSAL_GRAPH_MODE: options.graphMode } : process.env,
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
