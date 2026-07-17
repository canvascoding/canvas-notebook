import { Buffer } from 'node:buffer';

import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { runWithAgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { piTools } from '../app/lib/pi/core-tools';

type DriverInput = {
  toolName: 'read' | 'edit_file' | 'apply_patch' | 'edit_excalidraw_scene';
  toolCallId: string;
  params: Record<string, unknown>;
  context: AgentExecutionContext;
};

function input(): DriverInput {
  const encoded = process.argv[2]?.trim();
  if (!encoded) throw new Error('Expected a base64url-encoded collaboration agent tool payload.');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as DriverInput;
}

async function main(): Promise<void> {
  const request = input();
  const tool = piTools.find((candidate) => candidate.name === request.toolName);
  if (!tool) throw new Error(`Unknown tool: ${request.toolName}`);
  const result = await runWithAgentExecutionContext(
    request.context,
    () => tool.execute(request.toolCallId, request.params),
  );
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
