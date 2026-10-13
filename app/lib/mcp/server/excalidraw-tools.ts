import 'server-only';

import type { AuthInfo, CallToolResult } from '@modelcontextprotocol/server';
import { ExcalidrawApiInputError, excalidrawOperationFeedback, parseExcalidrawCreateInput,
  parseExcalidrawGetInput, parseExcalidrawEditInput } from '@/app/lib/excalidraw-collaboration/api-contract';
import { createExcalidrawDocument, getExcalidrawDocument, applyExcalidrawChanges } from '@/app/lib/excalidraw-collaboration/scene-service';
import { excalidrawRouteError } from '@/app/lib/excalidraw-collaboration/http';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { DirectMcpAuthorizationError } from './access-token-verifier';
import { createDirectMcpExcalidrawAuthority, type DirectMcpExcalidrawTool } from './excalidraw-authority';
import { directMcpToolAuthorizationError } from './tool-auth';
import type { DirectMcpToolDescriptor } from './tool-descriptor';

const tools = ['create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene'] as const;
const workspace = { type: 'string', minLength: 1, maxLength: 200, description: 'An explicitly allowed Canvas workspace ID.' };
const path = { type: 'string', minLength: 1, maxLength: 1024, description: 'Workspace-relative .excalidraw path.' };
const documentId = { type: 'string', minLength: 1, maxLength: 200, description: 'Stable documentId returned by Create or Get.' };
const key = { type: 'string', minLength: 1, maxLength: 500, description: 'Reuse the same key and identical request when retrying this operation.' };
const element = { type: 'object', description: 'Complete Excalidraw element JSON with a valid unique id, type, version and versionNonce.' };
const versionProperties = { elementId: { type: 'string', minLength: 1, maxLength: 128 },
  expectedVersion: { type: 'integer', minimum: 1 }, expectedVersionNonce: { type: 'integer', minimum: 0 } };

export function getDirectMcpExcalidrawToolDescriptor(id: DirectMcpExcalidrawTool): DirectMcpToolDescriptor {
  const read = id === 'get_excalidraw_scene';
  const create = id === 'create_excalidraw_scene';
  const securitySchemes = [{ type: 'oauth2' as const, scopes: [read ? 'knowledge:read' : 'knowledge:write'] }];
  return {
    name: id, title: create ? 'Create an Excalidraw diagram' : read ? 'Read an Excalidraw scene' : 'Edit Excalidraw elements safely',
    description: create ? 'Create a new initialized Excalidraw document without opening an editor. Never overwrites existing files. Returns document identity, lifecycle, scene sequence and a document link. Use get_excalidraw_scene and edit_excalidraw_scene for further work.'
      : read ? 'Read the authoritative Excalidraw scene from Canvas, including documentId, lifecycleGeneration, sceneSequence and element versions/nonces. Works for closed and personal documents. Specify documentId or path; when both are supplied, they must identify the same current document.'
        : 'Apply element create/update/delete actions to an Excalidraw diagram after reading its current scene. Supply its documentId, lifecycleGeneration and observedSceneSequence, and exact observed version/versionNonce for updates/deletes. A target conflict creates a persisted needs_review operation without applying any changes. Read the current scene again and submit updated actions with current versions and a new idempotency key. Inspect status and checkpoint separately and return documentUrl. Human Accept/Reject is available only when the experimental Review Center is enabled; it is disabled by default. Requests are limited to 1 MiB.',
    inputSchema: { type: 'object', additionalProperties: false,
      required: create ? ['workspaceId', 'path', 'idempotencyKey'] : read ? ['workspaceId']
        : ['workspaceId', 'documentId', 'lifecycleGeneration', 'observedSceneSequence', 'actions', 'idempotencyKey'],
      ...(read ? { anyOf: [{ required: ['documentId'] }, { required: ['path'] }] } : {}),
      properties: create ? { workspaceId: workspace, path, idempotencyKey: key }
        : read ? { workspaceId: workspace, documentId, path }
          : { workspaceId: workspace, documentId, path, idempotencyKey: key,
            lifecycleGeneration: { type: 'integer', minimum: 1, description: 'Exact lifecycleGeneration returned by the latest Get.' },
            observedSceneSequence: { type: 'integer', minimum: 0, description: 'The sceneSequence observed in the latest Get.' },
            actions: { type: 'array', minItems: 1, maxItems: 500, items: { oneOf: [
              { type: 'object', additionalProperties: false, required: ['type', 'element'], properties: { type: { const: 'create' }, element } },
              { type: 'object', additionalProperties: false,
                required: ['type', 'elementId', 'expectedVersion', 'expectedVersionNonce', 'element'],
                properties: { type: { const: 'update' }, ...versionProperties, element } },
              { type: 'object', additionalProperties: false,
                required: ['type', 'elementId', 'expectedVersion', 'expectedVersionNonce'],
                properties: { type: { const: 'delete' }, ...versionProperties } },
            ] } },
          },
    },
    annotations: { readOnlyHint: read, destructiveHint: id === 'edit_excalidraw_scene', idempotentHint: true, openWorldHint: false },
    securitySchemes, _meta: { securitySchemes },
  };
}

export function getDirectMcpExcalidrawToolDefinitions() {
  return tools.map(id => ({ id, descriptor: getDirectMcpExcalidrawToolDescriptor(id),
    execute: (args: unknown, authInfo?: AuthInfo, signal?: AbortSignal) => executeDirectMcpExcalidrawTool(id, args, authInfo, signal) }));
}

export async function executeDirectMcpExcalidrawTool(id: DirectMcpExcalidrawTool, raw: unknown,
  authInfo?: AuthInfo, signal?: AbortSignal): Promise<CallToolResult> {
  const scope = id === 'get_excalidraw_scene' ? 'knowledge:read' : 'knowledge:write';
  if (!authInfo?.token) return directMcpToolAuthorizationError(undefined, scope);
  try {
    signal?.throwIfAborted();
    const input = id === 'create_excalidraw_scene' ? parseExcalidrawCreateInput(raw)
      : id === 'get_excalidraw_scene' ? parseExcalidrawGetInput(raw) : parseExcalidrawEditInput(raw);
    if (!input.workspaceId) throw new ExcalidrawApiInputError('workspaceId is required for external MCP access.');
    const authority = await createDirectMcpExcalidrawAuthority({ token: authInfo.token, tool: id, workspaceId: input.workspaceId });
    const beforeApply = async () => { signal?.throwIfAborted(); await authority.verifyCurrent(); };
    let result;
    if (id === 'create_excalidraw_scene') {
      result = await createExcalidrawDocument({ ...parseExcalidrawCreateInput(raw), workspace: authority.workspace,
        actor: authority.actor, beforeApply });
    } else if (id === 'get_excalidraw_scene') {
      result = await withWorkspaceMutationLock(authority.workspace.workspaceId, async () => {
        signal?.throwIfAborted();
        return getExcalidrawDocument({ ...parseExcalidrawGetInput(raw), workspace: await authority.verifyCurrent(), actor: authority.actor });
      });
    } else {
      result = excalidrawOperationFeedback(await applyExcalidrawChanges({ ...parseExcalidrawEditInput(raw),
        workspace: authority.workspace, actor: authority.actor, beforeApply }));
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    if (error instanceof DirectMcpAuthorizationError) return directMcpToolAuthorizationError(error, scope);
    const response = excalidrawRouteError(error);
    const detail = await response.json() as { code: string; error: string };
    const result = { code: detail.code, message: detail.error, status: response.status };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }
}
