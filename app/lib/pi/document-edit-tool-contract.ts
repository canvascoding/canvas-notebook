import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { agentEditFileParameters } from './agent-file-tool-schemas';
import { piDocumentEditInputSchema, encodeNativeDocumentEditToolResult } from '../documents/edit-tool-contract';
import type { DocumentEditOperationResultV1 } from '../documents/edit-result-contract';
import { documentEditFailureV1 } from '../documents/edit-error-result';
export { decodePiNativeDocumentEditSelection, nativePiDocumentEditWire } from '../documents/edit-tool-contract';

// Preserve the exported legacy schema unchanged; providers keep an object at
// the root while the actual native decoder remains the final data validator.
export const piDocumentEditToolParameters = Type.Unsafe<Record<string, unknown>>(piDocumentEditInputSchema(agentEditFileParameters));
type Result = AgentToolResult<unknown> & { isError?: boolean };
export function formatPiNativeDocumentEditResult(value: DocumentEditOperationResultV1): Result {
  const details = encodeNativeDocumentEditToolResult(value);
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
}
export function formatPiNativeDocumentEditError(error: unknown): Result {
  const { body: details } = documentEditFailureV1(error);
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details, isError: true };
}
