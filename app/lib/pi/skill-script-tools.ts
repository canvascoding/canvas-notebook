import 'server-only';

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { getAgentExecutionContext, type AgentExecutionContext } from './agent-execution-context';
import { describeSkillScriptAction, listSkillScriptActions, runSkillScriptAction,
  SkillScriptRunError, type SkillScriptToolEffect } from '@/app/lib/skills/script-runtime/actions';
import { isSkillScriptError } from '@/app/lib/skills/script-runtime/contracts';
import { asAgentFileToolSuccess } from './agent-file-tool-results';

function resultWithEffects(text: string, details: Record<string, unknown>, effects: SkillScriptToolEffect[] = []): AgentToolResult<unknown> {
  const uiIntents = effects.flatMap(effect => {
    const data = effect.result.details;
    return data && typeof data === 'object' && 'uiIntent' in data && data.uiIntent ? [data.uiIntent] : [];
  });
  return { content: [{ type: 'text', text }], details: { ...details,
    ...(effects.length ? { toolResults: effects } : {}),
    ...(uiIntents.length ? { uiIntent: uiIntents[0], uiIntents } : {}) } };
}

/** Metadata is available without an actor; execution always requires its exact authenticated session. */
export function createSkillScriptTools(userId?: string, agentId?: string | null, sessionId?: string | null): AgentTool[] {
  const context = () => {
    const current = getAgentExecutionContext();
    if (!current || !userId || !sessionId || current.userId !== userId || current.sessionId !== sessionId
      || agentId && current.agentId !== agentId) throw new Error('An authenticated matching script session is required.');
    return current;
  };
  const loadTools = async (current: AgentExecutionContext) => {
    const { getPiTools } = await import('./tool-registry');
    return getPiTools(current.userId, current.agentId, current.sessionId,
      { executionContext: current, strictAuthorization: true });
  };
  const execute = (action: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>) =>
    async (_id: string, rawParams: unknown, signal?: AbortSignal) => {
      try {
        if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) throw new Error('Script arguments must be an object.');
        return await action(rawParams as Record<string, unknown>, signal);
      }
      catch (failure) {
        const uncertain = failure instanceof SkillScriptRunError && failure.terminateAgentTurn;
        return resultWithEffects(uncertain
          ? 'A script tool outcome is unknown. This run and agent turn stopped; inspect the provider before retrying.'
          : 'The skill script is unavailable or could not complete. Check the entrypoint, runtime and current permissions.',
        { kind: 'skill_script_result', error: true, code: isSkillScriptError(failure) ? failure.code : 'SCRIPT_ACCESS_DENIED',
          ...(failure instanceof SkillScriptRunError && failure.completedFiles.length
            ? { files: failure.completedFiles.map(file => asAgentFileToolSuccess(file, 'write')), outputPublication: 'partial' } : {}),
          ...(failure instanceof SkillScriptRunError && !uncertain && (failure.toolResults.length || failure.completedFiles.length)
            ? { completedEffects: true, safeToAutoRetry: false } : {}),
          ...(uncertain ? { terminateAgentTurn: true, outcome: 'outcome_unknown' } : {}) },
        failure instanceof SkillScriptRunError ? failure.toolResults : []);
      }
    };
  return [
    { name: 'list_canvas_skill_scripts', label: 'List Skill Scripts', executionMode: 'sequential',
      description: 'List declared script entrypoints of the currently selected published skills and their readiness. Installation alone grants no execution or external tool rights.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: execute(async () => {
        const scripts = await listSkillScriptActions(context(), loadTools);
        return resultWithEffects(JSON.stringify({ scripts }), { scripts });
      }) },
    { name: 'describe_canvas_skill_script', label: 'Describe Skill Script', executionMode: 'sequential',
      description: 'Load one listed skill script input schema, exact published revision, required tool aliases and declared output paths before running it.',
      parameters: Type.Object({ scriptRef: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
      execute: execute(async params => {
        const script = await describeSkillScriptAction(context(), String(params.scriptRef || ''), loadTools);
        return resultWithEffects(JSON.stringify({ script }), { script });
      }) },
    { name: 'run_canvas_skill_script', label: 'Run Skill Script', executionMode: 'sequential',
      description: 'Run one declared Node/Python entrypoint from its held immutable skill version in a restricted process with no direct network or provider credentials. Tool aliases intersect current agent permissions. Choose external tool/schema references discovered in this session; publish only explicitly mapped outputs through Canvas file operations.',
      parameters: Type.Object({
        scriptRef: Type.String({ minLength: 1, maxLength: 256 }),
        arguments: Type.Record(Type.String(), Type.Unknown()),
        selectedBindings: Type.Optional(Type.Array(Type.Object({ alias: Type.String({ minLength: 1, maxLength: 64 }),
          toolRef: Type.String({ minLength: 1, maxLength: 256 }), schemaRef: Type.String({ minLength: 1, maxLength: 256 }) },
        { additionalProperties: false }), { maxItems: 16 })),
        outputs: Type.Optional(Type.Array(Type.Object({ sourcePath: Type.String({ minLength: 1, maxLength: 1024 }),
          destinationPath: Type.String({ minLength: 1, maxLength: 1024 }), overwrite: Type.Optional(Type.Boolean()),
          expectedSha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })) }, { additionalProperties: false }), { maxItems: 32 })),
      }, { additionalProperties: false }),
      execute: execute(async (params, signal) => {
        const result = await runSkillScriptAction({ context: context(), arguments: params, loadTools, signal });
        const { toolResults, files, ...execution } = result;
        const script = { ...execution, files: files.map(file => asAgentFileToolSuccess(file, 'write')) };
        return resultWithEffects(JSON.stringify({ script }), { ...script, kind: 'skill_script_result', success: true, safeToAutoRetry: false }, toolResults);
      }) },
  ];
}
