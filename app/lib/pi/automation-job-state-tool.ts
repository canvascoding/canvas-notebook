import 'server-only';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  AutomationJobStateError,
  getAutomationJobState,
  listAutomationJobState,
  mutateAutomationJobState,
} from '@/app/lib/automations/job-state-store';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';

const MAX_LIST_LIMIT = 100;
const ALLOWED_FIELDS = new Set(['action', 'key', 'value', 'expectedRevision', 'mutationId', 'afterKey', 'limit']);

type JobStateToolInput = {
  action?: 'get' | 'list' | 'set' | 'delete';
  key?: string;
  value?: string;
  expectedRevision?: number | null;
  mutationId?: string;
  afterKey?: string;
  limit?: number;
};

function toolText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} };
}

/** The job and run identity are supplied by the runner, never by model arguments. */
export function createAutomationJobStateTool(binding: { jobId: string; runId: string }): AgentTool {
  return {
    name: 'automation_job_state',
    label: 'Automation job state',
    description: 'Read or update this automation job’s small durable key-value state. Use list to see key metadata, get to read one value, and set/delete with the current revision and a unique mutationId for safe retries. Do not store secrets, logs, or full answers.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('get'), Type.Literal('list'), Type.Literal('set'), Type.Literal('delete')]),
      key: Type.Optional(Type.String({ description: 'Key for get, set, or delete; maximum 128 printable characters.' })),
      value: Type.Optional(Type.String({ description: 'Value for set; maximum 16 KiB. Never store secrets.' })),
      expectedRevision: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
        description: 'Current revision for set/delete; use null only when creating a new key.',
      })),
      mutationId: Type.Optional(Type.String({ description: 'Unique ID for this write. Reuse exactly the same ID when retrying the same write.' })),
      afterKey: Type.Optional(Type.String({ description: 'For list, continue after this key.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT, description: 'List page size, at most 100.' })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as JobStateToolInput;
      const context = getAgentExecutionContext();
      let auditStatus: 'success' | 'blocked' | 'failure' = 'success';
      let auditCode: string | null = null;
      let revision: number | null = null;
      try {
        if (!params || typeof params !== 'object' || Array.isArray(params)
          || Object.keys(params).some((field) => !ALLOWED_FIELDS.has(field))) {
          throw new AutomationJobStateError('Invalid job-state arguments.', 'INVALID_INPUT');
        }
        const access = { kind: 'run' as const, runId: binding.runId };
        if (params.action === 'list') {
          if (params.key !== undefined || params.value !== undefined || params.expectedRevision !== undefined
            || params.mutationId !== undefined || (params.afterKey !== undefined && typeof params.afterKey !== 'string')
            || (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > MAX_LIST_LIMIT))) {
            throw new AutomationJobStateError('Invalid list arguments.', 'INVALID_INPUT');
          }
          const entries = (await listAutomationJobState(binding.jobId, access))
            .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
          const start = params.afterKey === undefined ? 0 : entries.findIndex((entry) => entry.key > params.afterKey!);
          const page = start < 0 ? [] : entries.slice(start, start + (params.limit ?? 50));
          return toolText({ entries: page, nextAfterKey: start >= 0 && start + page.length < entries.length
            ? page.at(-1)?.key ?? null : null });
        }
        if (params.action === 'get') {
          if (typeof params.key !== 'string' || params.value !== undefined || params.expectedRevision !== undefined
            || params.mutationId !== undefined || params.afterKey !== undefined || params.limit !== undefined) {
            throw new AutomationJobStateError('Invalid get arguments.', 'INVALID_INPUT');
          }
          const entry = await getAutomationJobState(binding.jobId, params.key, access);
          revision = entry?.revision ?? null;
          return toolText({ entry });
        }
        if (params.action === 'set' || params.action === 'delete') {
          if (typeof params.key !== 'string' || typeof params.mutationId !== 'string'
            || !Object.hasOwn(params, 'expectedRevision') || params.afterKey !== undefined || params.limit !== undefined
            || (params.action === 'set' && typeof params.value !== 'string')
            || (params.action === 'delete' && params.value !== undefined)) {
            throw new AutomationJobStateError('Invalid write arguments.', 'INVALID_INPUT');
          }
          const result = await mutateAutomationJobState({ jobId: binding.jobId, access,
            action: params.action, key: params.key, value: params.value,
            expectedRevision: params.expectedRevision!, mutationId: params.mutationId });
          revision = result.action === 'set' ? result.entry.revision : result.previousRevision;
          return toolText({ result });
        }
        throw new AutomationJobStateError('Unknown job-state action.', 'INVALID_INPUT');
      } catch (error) {
        auditStatus = error instanceof AutomationJobStateError && error.code === 'ACCESS_DENIED' ? 'blocked' : 'failure';
        auditCode = error instanceof AutomationJobStateError ? error.code : 'UNAVAILABLE';
        return toolText({ error: auditCode, message: error instanceof AutomationJobStateError
          ? error.message : 'Automation job state is unavailable.' });
      } finally {
        const auditAction = ['get', 'list', 'set', 'delete'].includes(params?.action ?? '') ? params.action : 'unknown';
        await recordAuditEvent({
          organizationId: context?.organizationId, workspaceId: context?.workspaceId,
          userId: context?.userId, sessionId: context?.sessionId, agentId: context?.agentId,
          source: 'automations', eventType: 'automation', entityType: 'automation_job', entityId: binding.jobId,
          action: `automation_job_state.${auditAction}`, status: auditStatus,
          summary: `Automation job state ${auditAction} ${auditStatus}.`,
          metadata: { runId: binding.runId, key: typeof params?.key === 'string' ? params.key : null,
            revision, valueBytes: params?.action === 'set' && typeof params.value === 'string'
              ? Buffer.byteLength(params.value, 'utf8') : null, errorCode: auditCode },
        });
      }
    },
  };
}
