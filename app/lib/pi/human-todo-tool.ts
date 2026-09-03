import { type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

import {
  createTodo,
  type TodoFileLinkInput,
  type TodoPriority,
} from '@/app/lib/todos/store';
import { TODO_ICON_KEYS, isTodoIconKey } from '@/app/lib/todos/icons';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { USER_TODO_SCOPE, todoScopeForWorkspace } from '@/app/lib/todos/scope';

function parseDueAt(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('dueAt must be an ISO date string, timestamp, or empty.');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('dueAt must be a valid date.');
  }
  return date;
}

function normalizePriority(value: unknown): TodoPriority | undefined {
  return value === 'low' || value === 'normal' || value === 'high' ? value : undefined;
}

function normalizeFileLinks(value: unknown): TodoFileLinkInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('fileLinks must be an array of workspace-relative paths.');
  }
  return value.flatMap((entry): TodoFileLinkInput[] => {
    if (typeof entry === 'string' && entry.trim()) return [entry];
    if (entry && typeof entry === 'object') {
      const link = entry as Record<string, unknown>;
      if (typeof link.workspacePath === 'string' && link.workspacePath.trim()) {
        return [{ workspacePath: link.workspacePath, label: typeof link.label === 'string' ? link.label : null }];
      }
    }
    return [];
  });
}

export function createHumanTodoTool(deps: { userId?: string; agentId?: string | null; sessionId?: string | null } = {}): AgentTool {
  const sourceAgentId = normalizeManagedAgentId(deps.agentId);
  const sourceSessionId = typeof deps.sessionId === 'string' && deps.sessionId.trim()
    ? deps.sessionId.trim()
    : null;

  return {
    name: 'create_human_todo',
    label: 'Creating human to-do',
    description:
      'Creates a to-do for the human workspace user. Use when a task is complete but the human still needs to review, decide, approve, provide input, perform offline work, or follow up. ' +
      'Never include secrets, tokens, passwords, private raw credentials, or large logs. Keep the to-do concrete and actionable.',
    parameters: Type.Object({
      title: Type.String({ description: 'Short, concrete action title for the human. Example: "Review generated contract draft".' }),
      description: Type.Optional(Type.String({ description: 'Brief context and why human action is required. Keep it concise and avoid secrets.' })),
      categoryName: Type.Optional(Type.String({ description: 'Preferred category name. Use one of: To-do, Review, Approval, Automation. German aliases like Prüfen and Freigabe are accepted. Defaults to To-do.' })),
      priority: Type.Optional(Type.Union([
        Type.Literal('low'),
        Type.Literal('normal'),
        Type.Literal('high'),
      ], { description: 'Priority for the human. Defaults to normal.' })),
      iconKey: Type.Optional(Type.Union(TODO_ICON_KEYS.map((key) => Type.Literal(key)), {
        description: 'Optional visual icon. Use check, eye, approval, message, file, calendar, warning, idea, user, or settings.',
      })),
      dueAt: Type.Optional(Type.String({ description: 'Optional due date or timestamp, preferably ISO 8601.' })),
      remindAt: Type.Optional(Type.String({ description: 'Optional reminder timestamp, preferably ISO 8601.' })),
      fileLinks: Type.Optional(Type.Array(Type.Union([
        Type.String(),
        Type.Object({ workspacePath: Type.String(), label: Type.Optional(Type.String()) }),
      ]), {
        description: 'Optional workspace-relative file paths relevant to the task. Absolute paths, URLs, and traversal are rejected.',
        maxItems: 20,
      })),
      assigneeUserId: Type.String({
        description: 'Required responsible person. Use "me" for the current human workspace user, or provide a user ID. For team workspace to-dos the assignee must be a member of the organization.',
        minLength: 1,
      }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        if (!deps.userId) {
          throw new Error('User ID is required for create_human_todo.');
        }

        const input = params as Record<string, unknown>;
        const executionContext = getAgentExecutionContext();
        const workspaceScope = executionContext
          ? todoScopeForWorkspace(executionContext)
          : USER_TODO_SCOPE;
        const requestedAssigneeUserId = typeof input.assigneeUserId === 'string'
          ? input.assigneeUserId.trim()
          : '';
        if (!requestedAssigneeUserId) {
          throw new Error('assigneeUserId is required for create_human_todo. Use "me" for the current human workspace user.');
        }

        const todo = await createTodo(deps.userId, {
          ...workspaceScope,
          title: String(input.title ?? ''),
          description: typeof input.description === 'string' ? input.description : null,
          categoryName: typeof input.categoryName === 'string' ? input.categoryName : null,
          priority: normalizePriority(input.priority),
          iconKey: isTodoIconKey(input.iconKey) ? input.iconKey : null,
          dueAt: parseDueAt(input.dueAt),
          remindAt: parseDueAt(input.remindAt),
          assigneeUserId: requestedAssigneeUserId === 'me' ? deps.userId : requestedAssigneeUserId,
          sourceType: 'agent',
          sourceAgentId,
          sourceSessionId,
          seenAt: null,
          fileLinks: normalizeFileLinks(input.fileLinks),
        });

        const lines = [
          'Human to-do created.',
          `ID: ${todo.id}`,
          `Title: ${todo.title}`,
          `Category: ${todo.category?.name ?? 'To-do'}`,
          `Priority: ${todo.priority}`,
          `Scope: ${todo.scopeKind === 'workspace' ? todo.workspace?.name || todo.workspaceType : 'Across personal workspaces'}`,
          todo.assignee ? `Assignee: ${todo.assignee.name || todo.assignee.email || todo.assignee.id}` : null,
          `Visible in UI: /todos`,
        ].filter((line): line is string => Boolean(line));

        if (todo.fileLinks.length > 0) {
          lines.push('Linked files:');
          lines.push(...todo.fileLinks.map((link) => `- ${link.workspacePath}`));
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: { todo },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create human to-do.';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
