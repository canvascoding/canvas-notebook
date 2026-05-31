import { type AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';

import {
  createTodo,
  type TodoFileLinkInput,
  type TodoPriority,
} from '@/app/lib/todos/store';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';

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
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
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
      dueAt: Type.Optional(Type.String({ description: 'Optional due date or timestamp, preferably ISO 8601.' })),
      fileLinks: Type.Optional(Type.Array(Type.String(), {
        description: 'Optional workspace-relative file paths relevant to the task. Absolute paths, URLs, and traversal are rejected.',
        maxItems: 20,
      })),
      sourceSessionId: Type.Optional(Type.String({ description: 'Optional Canvas Agent session ID. Usually set automatically by Canvas when this tool runs inside a chat session.' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        if (!deps.userId) {
          throw new Error('User ID is required for create_human_todo.');
        }

        const input = params as Record<string, unknown>;
        const todo = await createTodo(deps.userId, {
          title: String(input.title ?? ''),
          description: typeof input.description === 'string' ? input.description : null,
          categoryName: typeof input.categoryName === 'string' ? input.categoryName : null,
          priority: normalizePriority(input.priority),
          dueAt: parseDueAt(input.dueAt),
          sourceType: 'agent',
          sourceAgentId,
          sourceSessionId: sourceSessionId || (typeof input.sourceSessionId === 'string' ? input.sourceSessionId : null),
          seenAt: null,
          fileLinks: normalizeFileLinks(input.fileLinks),
        });

        const lines = [
          'Human to-do created.',
          `ID: ${todo.id}`,
          `Title: ${todo.title}`,
          `Category: ${todo.category?.name ?? 'To-do'}`,
          `Priority: ${todo.priority}`,
          `Visible in UI: /todos`,
        ];

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
