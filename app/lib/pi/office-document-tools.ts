import 'server-only';

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

import { getAgentExecutionContext } from './agent-execution-context';
import { createOfficeDocumentWorkflow, type OfficeCheckoutResult } from './office-document-workflow';

export const OFFICE_DOCUMENT_TOOL_NAMES = ['checkout_docx', 'commit_docx', 'inspect_docx_checkout', 'release_docx_checkout'] as const;

function toolResult(result: OfficeCheckoutResult): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
}

export function createOfficeDocumentTools(workflow = createOfficeDocumentWorkflow()): AgentTool[] {
  const execute = (operation: (params: Record<string, unknown>, context: NonNullable<ReturnType<typeof getAgentExecutionContext>>, signal?: AbortSignal) => Promise<OfficeCheckoutResult>): AgentTool['execute'] =>
    async (_toolCallId, params, signal) => {
      try {
        const context = getAgentExecutionContext();
        if (!context) throw new Error('DOCX tools require a workspace-bound agent session.');
        return toolResult(await operation(params as Record<string, unknown>, context, signal));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'DOCX operation failed.';
        return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
      }
    };

  return [
    {
      name: 'checkout_docx', label: 'Preparing Word working copy',
      description: 'Start a Word edit by checking out a fixed version into a session scratch workingPath. Original workspace files are read-only to shell/Python. Edit only workingPath and publish with commit_docx. Set createOnly=true to reserve a new DOCX path; create the returned workingPath with python-docx. Preserve checkoutId and renew its lease before lockExpiresAt with inspect_docx_checkout.',
      parameters: Type.Object({ path: Type.String({ description: 'Workspace-relative .docx input or new output path.' }), createOnly: Type.Optional(Type.Boolean()) }),
      execute: execute((params, context, signal) => workflow.checkout({ path: String(params.path ?? ''), createOnly: params.createOnly === true }, context, signal)),
    },
    {
      name: 'commit_docx', label: 'Publishing Word changes',
      description: 'Validate and publish a completed DOCX working copy through its checkoutId. The server enforces the original version, editor lease and current session permissions. Wait for Python/render subprocesses to finish before committing. On conflict, the proposed bytes remain durable under recoveryId; do not retry with a replacement baseline. A repeated successful checkoutId returns the same result.',
      parameters: Type.Object({ checkoutId: Type.String() }),
      execute: execute((params, context, signal) => workflow.commit(String(params.checkoutId ?? ''), context, signal)),
    },
    {
      name: 'inspect_docx_checkout', label: 'Inspecting Word working copy',
      description: 'Inspect a DOCX checkout in this task. Set renewLease=true before expiry to extend its existing lease (never recreates expired ownership). Set restoreWorkingCopy=true to copy the last durable candidate/original back into scratch after cleanup; this explicitly replaces the scratch workingPath, never the original workspace document.',
      parameters: Type.Object({ checkoutId: Type.String(), renewLease: Type.Optional(Type.Boolean()), restoreWorkingCopy: Type.Optional(Type.Boolean()) }),
      execute: execute((params, context, signal) => workflow.inspect({ checkoutId: String(params.checkoutId ?? ''), renewLease: params.renewLease === true, restoreWorkingCopy: params.restoreWorkingCopy === true }, context, signal)),
    },
    {
      name: 'release_docx_checkout', label: 'Releasing Word edit lease',
      description: 'Stop editing a DOCX without publishing: preserve the current working copy in durable recovery storage and release its lease. A released checkout cannot commit; recover its draft with inspect_docx_checkout and use a new createOnly checkout for a separate proposal document.',
      parameters: Type.Object({ checkoutId: Type.String() }),
      execute: execute((params, context) => workflow.release(String(params.checkoutId ?? ''), context)),
    },
  ];
}
