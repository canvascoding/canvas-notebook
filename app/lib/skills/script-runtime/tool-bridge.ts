import 'server-only';

import { randomUUID } from 'node:crypto';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { runWithAgentExecutionContext, type AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { isProgressiveGatewayTool } from '@/app/lib/pi/progressive-tool-gateway';
import { PLANNING_MODE_ALLOWED_TOOLS } from '@/app/lib/pi/planning-mode';
import { isIntegrationGatewayTool, type IntegrationGatewayAgentTool } from '@/app/lib/pi/integration-tool-gateway';
import { readIntegrationGatewayErrorCode, readIntegrationContractErrorCode, INTEGRATION_GATEWAY_ERROR_MESSAGES } from '@/app/lib/integration-tools/agent-errors';
import { cloneIntegrationArguments, schemaFingerprint, validateIntegrationArguments } from '@/app/lib/integration-tools/schema';
import { isIntegrationTurnUncertain, markIntegrationTurnUncertain } from '@/app/lib/integration-tools/uncertain-turns';
import { isPersistedIntegrationTurnUncertain, persistIntegrationTurnUncertain } from '@/app/lib/integration-tools/uncertain-turn-store';
import { resolveIntegrationDelegationTaskBinding } from '@/app/lib/integration-tools/runtime-policy';
import type { IntegrationUncertainTurnContext } from '@/app/lib/integration-tools/uncertain-turns';
import { SkillScriptError, isSkillScriptError, type SkillScriptDeclaration, type SkillScriptToolRequirement } from './contracts';

export const SCRIPT_BRIDGE_LIMITS = Object.freeze({ frameBytes: 64 * 1024, totalBytes: 1024 * 1024,
  depth: 32, aliases: 16, calls: 8, describes: 16, rpcMs: 30_000 });

const requestSchema = z.object({ version: z.literal(1), id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  action: z.enum(['describe', 'call']), alias: z.string().min(1).max(64),
  schemaHandle: z.string().min(1).max(200).optional(), arguments: z.record(z.string(), z.unknown()).optional() }).strict();

const unsafeNative = new Set(['bash', 'terminal', 'browser', 'web_fetch', 'web_search', 'mcp', 'composio', 'integrations',
  'run_canvas_skill_script', 'run_skill_script', 'run_skill', 'delegate_task', 'agent_manage', 'canvas_extensions',
  'automation_manage', 'email', 'security', 'set_onboarding_profile']);
const readOnlyEmail = new Set(['email_list_mailboxes', 'email_search_messages', 'email_read_message',
  'email_list_thread_messages', 'email_list_cases', 'email_list_outbox_drafts']);

export function isSkillScriptNativeToolAllowed(name: string): boolean {
  return !unsafeNative.has(name) && !/^mcp_/iu.test(name)
    && !/(?:canvas_(?:package|plugin|skill|resource)|(?:create|update|delete|set|remove|inspect|list|preview)_agent|automation|secret|credential|connection|integrations?_env|COMPOSIO_)/iu.test(name);
}

function jsonBytes(value: unknown): number {
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.depth > SCRIPT_BRIDGE_LIMITS.depth || ++visited > 50_000) throw new SkillScriptError('SCRIPT_LIMIT_EXCEEDED', 'The bridge JSON exceeds its bounds.');
    if (entry.value && typeof entry.value === 'object') {
      for (const item of Object.values(entry.value)) pending.push({ value: item, depth: entry.depth + 1 });
    }
  }
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { throw new SkillScriptError('SCRIPT_PROTOCOL_INVALID', 'A JSON bridge message is required.'); }
}

type NativeRoute = { tool: AgentTool; operation?: string; schema: unknown };
type Handle = { alias: string; fingerprint: string };
type Outcome = 'not_started' | 'completed' | 'unknown';
type Response = { version: 1; id: number; ok: boolean; data?: unknown;
  error?: { code: string; message: string; outcome: Outcome }; terminate?: true };

function nativeRoute(tools: AgentTool[], name: string): NativeRoute | null {
  if (!isSkillScriptNativeToolAllowed(name)) return null;
  for (const tool of tools) {
    if (isProgressiveGatewayTool(tool)) {
      const operation = tool.progressiveGateway.operations.find(candidate => candidate.name === name);
      if (operation) return { tool, operation: name, schema: operation.parameters };
    } else if (tool.name === name) return { tool, schema: tool.parameters };
  }
  return null;
}

function fdResult(result: AgentToolResult<unknown>): unknown {
  return { content: result.content.filter(item => item.type === 'text').map(item => ({ type: 'text', text: item.text })),
    ...(result.details && typeof result.details === 'object' && 'structuredContent' in result.details
      ? { structuredContent: result.details.structuredContent } : {}) };
}

export function createSkillScriptToolBridge(input: {
  entry: SkillScriptDeclaration; scriptRef: string; context: AgentExecutionContext;
  selectedBindings: ReadonlyArray<{ alias: string; toolRef: string; schemaRef: string }>;
  loadTools: (freshContext: AgentExecutionContext) => Promise<AgentTool[]>;
  revalidate: () => Promise<AgentExecutionContext>; signal?: AbortSignal; onTerminate: (reason: string) => void;
}) {
  const entry = structuredClone(input.entry), context = { ...input.context }, bindings = structuredClone(input.selectedBindings);
  if (!input.scriptRef || !context.userId || !context.sessionId || !context.agentId || !context.workspaceId
    || entry.tools.length > SCRIPT_BRIDGE_LIMITS.aliases) throw new SkillScriptError('SCRIPT_ACCESS_DENIED', 'A current script execution context is required.', 403);
  const requirements = new Map<string, SkillScriptToolRequirement>();
  for (const requirement of entry.tools) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(requirement.alias) || requirements.has(requirement.alias)
      || requirement.kind === 'native' && !isSkillScriptNativeToolAllowed(requirement.toolName)) {
      throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'This script declares an unsupported or ambiguous tool.', 403);
    }
    requirements.set(requirement.alias, requirement);
  }
  const selected = new Map<string, { toolRef: string; schemaRef: string }>();
  for (const binding of bindings) {
    if (selected.has(binding.alias) || requirements.get(binding.alias)?.kind !== 'integration' || !binding.toolRef || !binding.schemaRef) {
      throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'The script tool selection is invalid.', 403);
    }
    selected.set(binding.alias, { toolRef: binding.toolRef, schemaRef: binding.schemaRef });
  }
  for (const requirement of requirements.values()) if (requirement.kind === 'integration' && !selected.has(requirement.alias)) {
    throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'Select the declared integration tool before starting this script.', 403);
  }
  const handles = new Map<string, Handle>();
  const results: Array<{ toolName: string; result: AgentToolResult<unknown> }> = [];
  let closed = false, busy = false, terminated = false, activeBusiness = false, lastId = 0, calls = 0, describes = 0, totalBytes = 0;
  let parentTurn: IntegrationUncertainTurnContext | undefined, persistenceConfirmed = true;
  const stop = (reason: string) => { closed = true; handles.clear(); if (!terminated) { terminated = true; input.onTerminate(reason); } };
  const uncertain = async () => {
    markIntegrationTurnUncertain(context);
    if (parentTurn) markIntegrationTurnUncertain(parentTurn);
    stop('SCRIPT_OUTCOME_UNKNOWN');
    try {
      await bounded(async () => {
        await persistIntegrationTurnUncertain(context);
        if (parentTurn) await persistIntegrationTurnUncertain(parentTurn);
      }, false);
    } catch { persistenceConfirmed = false; }
  };
  const bounded = async <T,>(operation: () => Promise<T>, observeAbort = true): Promise<T> => {
    if (observeAbort) input.signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const fence = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SkillScriptError('SCRIPT_TIMEOUT', 'The bridge operation exceeded its time budget.')), SCRIPT_BRIDGE_LIMITS.rpcMs);
      abort = () => reject(new SkillScriptError('SCRIPT_ABORTED', 'The bridge operation was aborted.'));
      if (observeAbort) input.signal?.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(operation), fence]); }
    finally { clearTimeout(timer); if (abort) input.signal?.removeEventListener('abort', abort); }
  };
  const respond = (response: Response, outcome: Outcome): Response => {
    const bytes = jsonBytes(response);
    if (bytes > SCRIPT_BRIDGE_LIMITS.frameBytes || totalBytes + bytes > SCRIPT_BRIDGE_LIMITS.totalBytes) {
      stop('SCRIPT_LIMIT_EXCEEDED');
      return { version: 1, id: response.id, ok: false, error: { code: 'SCRIPT_LIMIT_EXCEEDED',
        message: 'The tool result exceeds the bridge output budget.', outcome }, terminate: true };
    }
    totalBytes += bytes;
    return response;
  };
  const fresh = async () => {
    input.signal?.throwIfAborted();
    const current = await input.revalidate();
    for (const key of ['userId', 'sessionId', 'agentId', 'workspaceId', 'organizationId', 'agentTurnId'] as const) {
      if (current[key] !== context[key]) throw new SkillScriptError('SCRIPT_ACCESS_DENIED', 'The originating script context changed.', 403);
    }
    if (closed) throw new SkillScriptError('SCRIPT_ABORTED', 'The script tool bridge is closed.');
    if (isIntegrationTurnUncertain(context) || await isPersistedIntegrationTurnUncertain(context)) {
      throw new SkillScriptError('SCRIPT_OUTCOME_UNKNOWN', 'Execution may have completed. Inspect it before repeating.');
    }
    const task = await resolveIntegrationDelegationTaskBinding(current);
    if (task) {
      parentTurn = { userId: context.userId, sessionId: task.sourceSessionId, agentId: task.sourceAgentId,
        workspaceId: context.workspaceId, agentTurnId: task.sourceAgentTurnId ?? undefined };
      if (isIntegrationTurnUncertain(parentTurn) || await isPersistedIntegrationTurnUncertain(parentTurn)) {
        throw new SkillScriptError('SCRIPT_OUTCOME_UNKNOWN', 'The parent execution outcome is unconfirmed. Inspect it before repeating.');
      }
    }
    const tools = await input.loadTools(current);
    return { current, tools };
  };
  const external = async (requirement: Extract<SkillScriptToolRequirement, { kind: 'integration' }>, tools: AgentTool[], current: AgentExecutionContext) => {
    const tool = tools.find(isIntegrationGatewayTool) as IntegrationGatewayAgentTool | undefined, binding = selected.get(requirement.alias)!;
    if (!tool || typeof tool.integrationGateway.inspectScriptBinding !== 'function') throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'The declared integration is not available to this agent.', 403);
    const identity = await bounded(() => runWithAgentExecutionContext(current, () => tool.integrationGateway.inspectScriptBinding(binding.toolRef, binding.schemaRef, input.signal)));
    if (identity.source !== requirement.source || identity.toolName !== requirement.toolName
      || requirement.application !== undefined && identity.application !== requirement.application) {
      throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'The selected integration does not match the declared tool.', 403);
    }
    return { tool, binding, identity };
  };
  const handle = async (raw: unknown): Promise<Response> => {
    let id = 0, dispatched = false, completed = false, nativeDispatch = false, nativeReadOnly = false;
    if (busy) { stop('SCRIPT_PROTOCOL_INVALID'); return { version: 1, id, ok: false,
      error: { code: 'SCRIPT_PROTOCOL_INVALID', message: 'Only one bridge request may be in flight.', outcome: 'not_started' }, terminate: true }; }
    busy = true;
    try {
      if (closed) throw new SkillScriptError('SCRIPT_ABORTED', 'The script tool bridge is closed.');
      const bytes = jsonBytes(raw);
      if (bytes > SCRIPT_BRIDGE_LIMITS.frameBytes || totalBytes + bytes > SCRIPT_BRIDGE_LIMITS.totalBytes) throw new SkillScriptError('SCRIPT_LIMIT_EXCEEDED', 'The bridge request exceeds its byte budget.');
      totalBytes += bytes;
      const request = requestSchema.parse(raw); id = request.id;
      if (id <= lastId) throw new SkillScriptError('SCRIPT_PROTOCOL_INVALID', 'Bridge request IDs must increase without replay.');
      lastId = id;
      const requirement = requirements.get(request.alias);
      if (!requirement) throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'This tool alias is not declared by the script.', 403);
      if (request.action === 'describe') {
        if (request.arguments !== undefined || request.schemaHandle !== undefined) throw new SkillScriptError('SCRIPT_PROTOCOL_INVALID', 'Describe accepts only a declared alias.');
        if (++describes > SCRIPT_BRIDGE_LIMITS.describes) throw new SkillScriptError('SCRIPT_LIMIT_EXCEEDED', 'The schema request budget is exhausted.');
      } else if (++calls > SCRIPT_BRIDGE_LIMITS.calls) throw new SkillScriptError('SCRIPT_LIMIT_EXCEEDED', 'The tool call budget is exhausted.');
      let { current, tools } = await bounded(fresh);
      let schema: unknown, fingerprint: string, execute: () => Promise<AgentToolResult<unknown>>;
      const toolCallId = `skill-script:${input.scriptRef}:${id}`;
      if (requirement.kind === 'native') {
        const route = nativeRoute(tools, requirement.toolName);
        if (!route) throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'The declared native tool is not available to this agent.', 403);
        schema = JSON.parse(JSON.stringify(route.schema));
        fingerprint = schemaFingerprint(schema);
        const args = cloneIntegrationArguments(request.arguments ?? {});
        execute = () => route.operation
          ? route.tool.execute(toolCallId, { action: 'call', operation: route.operation, arguments: args }, input.signal)
          : route.tool.execute(toolCallId, args, input.signal);
        nativeDispatch = true;
        nativeReadOnly = PLANNING_MODE_ALLOWED_TOOLS.has(requirement.toolName) || readOnlyEmail.has(requirement.toolName);
      } else {
        const resolved = await external(requirement, tools, current);
        schema = resolved.identity.inputSchema;
        fingerprint = schemaFingerprint([requirement, resolved.binding, resolved.identity]);
        execute = () => resolved.tool.execute(toolCallId, { action: 'call', ...resolved.binding, arguments: cloneIntegrationArguments(request.arguments ?? {}) }, input.signal);
      }
      if (request.action === 'describe') {
        const schemaHandle = `skill-script-schema:${randomUUID()}`;
        handles.set(schemaHandle, { alias: requirement.alias, fingerprint });
        return respond({ version: 1, id, ok: true, data: { schemaHandle, inputSchema: schema } }, 'not_started');
      }
      const issued = request.schemaHandle ? handles.get(request.schemaHandle) : null;
      if (!issued || issued.alias !== requirement.alias || issued.fingerprint !== fingerprint) throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'Describe this current tool alias before calling it.', 403);
      if (nativeDispatch) {
        await validateIntegrationArguments(schema, request.arguments ?? {});
        ({ current, tools } = await bounded(fresh));
        const route = nativeRoute(tools, requirement.toolName);
        if (!route || schemaFingerprint(route.schema) !== fingerprint) throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'The native tool or its permissions changed.', 403);
        const args = cloneIntegrationArguments(request.arguments ?? {});
        execute = () => route.operation
          ? route.tool.execute(toolCallId, { action: 'call', operation: route.operation, arguments: args }, input.signal)
          : route.tool.execute(toolCallId, args, input.signal);
      }
      input.signal?.throwIfAborted();
      if (closed) throw new SkillScriptError('SCRIPT_ABORTED', 'The script tool bridge is closed.');
      dispatched = true;
      activeBusiness = !nativeReadOnly;
      const result = await bounded(() => runWithAgentExecutionContext(current, execute));
      const nativeError = nativeDispatch && result.details && typeof result.details === 'object' && 'error' in result.details && result.details.error;
      results.push({ toolName: requirement.kind === 'native' ? requirement.toolName : 'integrations', result: nativeError
        ? { content: [{ type: 'text', text: nativeReadOnly ? 'The native read operation failed.' : 'The native tool outcome could not be confirmed. Inspect it before repeating.' }],
          details: { error: nativeReadOnly ? 'The native read operation failed.' : 'The native tool outcome could not be confirmed.',
            code: nativeReadOnly ? 'SCRIPT_EXECUTION_FAILED' : 'SCRIPT_OUTCOME_UNKNOWN' } } : result });
      const integrationError = readIntegrationGatewayErrorCode('integrations', result.details);
      if (integrationError) {
        dispatched = integrationError === 'outcome_unknown';
        if (dispatched) await uncertain();
        return respond({ version: 1, id, ok: false, error: { code: integrationError,
          message: INTEGRATION_GATEWAY_ERROR_MESSAGES[integrationError], outcome: dispatched ? 'unknown' : 'not_started' }, ...(dispatched ? { terminate: true as const } : {}) }, dispatched ? 'unknown' : 'not_started');
      }
      if (nativeError) {
        if (nativeReadOnly) {
          completed = true;
          return respond({ version: 1, id, ok: false, error: { code: 'SCRIPT_EXECUTION_FAILED', message: 'The native read operation failed.', outcome: 'completed' } }, 'completed');
        }
        await uncertain(); throw new SkillScriptError('SCRIPT_OUTCOME_UNKNOWN', 'The native tool outcome could not be confirmed. Inspect it before repeating.');
      }
      if ('terminate' in result && result.terminate === true) {
        await uncertain(); throw new SkillScriptError('SCRIPT_OUTCOME_UNKNOWN', 'The tool requires execution to stop. Inspect its outcome before repeating.');
      }
      completed = true;
      activeBusiness = false;
      return respond({ version: 1, id, ok: true, data: fdResult(result) }, 'completed');
    } catch (error) {
      const failedRead = dispatched && nativeReadOnly;
      const unknown = dispatched && !completed && !nativeReadOnly || isSkillScriptError(error) && error.code === 'SCRIPT_OUTCOME_UNKNOWN';
      if (unknown) await uncertain();
      const integration = readIntegrationContractErrorCode(error);
      const code = unknown ? 'SCRIPT_OUTCOME_UNKNOWN' : isSkillScriptError(error) ? error.code : failedRead ? 'SCRIPT_EXECUTION_FAILED' : integration ?? (error instanceof z.ZodError ? 'SCRIPT_PROTOCOL_INVALID' : 'SCRIPT_TOOL_DENIED');
      const message = unknown ? persistenceConfirmed ? 'Execution may have completed. Inspect it before repeating.' : 'Execution may have completed and its durable status could not be confirmed. Keep the run stopped and inspect it before repeating.'
        : failedRead ? 'The native read operation failed.' : isSkillScriptError(error) ? error.message : integration ? INTEGRATION_GATEWAY_ERROR_MESSAGES[integration] : 'The bridge request could not be authorized.';
      if (['SCRIPT_PROTOCOL_INVALID', 'SCRIPT_LIMIT_EXCEEDED'].includes(code)) stop(code);
      return respond({ version: 1, id, ok: false, error: { code, message, outcome: unknown ? 'unknown' : completed || failedRead ? 'completed' : 'not_started' }, ...(closed ? { terminate: true as const } : {}) }, unknown ? 'unknown' : completed || failedRead ? 'completed' : 'not_started');
    } finally { busy = false; activeBusiness = false; }
  };
  const prepare = async () => {
    const { current, tools } = await bounded(fresh);
    for (const requirement of requirements.values()) {
      if (requirement.kind === 'native') {
        if (!nativeRoute(tools, requirement.toolName)) throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'The declared native tool is not available to this agent.', 403);
      } else await external(requirement, tools, current);
    }
  };
  return { prepare, handle, results, close: () => { closed = true; handles.clear(); if (activeBusiness) void uncertain(); } };
}
