import 'server-only';

import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { getProgressiveGatewayCapabilityNames } from '@/app/lib/pi/progressive-tool-gateway';
import { runWithAgentExecutionContext, type AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { resolveAgentExecutionContextForStoredSession } from '@/app/lib/pi/session-workspace-context';
import { reissueCapabilityPackageRuntimeBindings } from '@/app/lib/capabilities/packages/runtime-bindings';
import { normalizeCapabilityPackageRelativePath } from '@/app/lib/capabilities/packages/io';
import { validateIntegrationArguments, cloneIntegrationArguments } from '@/app/lib/integration-tools/schema';
import { isPersistedIntegrationTurnUncertain } from '@/app/lib/integration-tools/uncertain-turn-store';
import { prepareScratchDirectory } from '@/app/lib/pi/agent-shell-sandbox';
import { acquireAgentRuntimeTempLease } from '@/app/lib/pi/agent-runtime-temp';
import { writeAgentBinaryFile, type AgentFileChangeResult } from '@/app/lib/pi/agent-file-operations';
import { authorizeSkillScript, listAuthorizedSkillScripts } from './authorization';
import { executeSkillScriptProcess, probeSkillScriptRuntime } from './process';
import { createSkillScriptToolBridge, isSkillScriptNativeToolAllowed } from './tool-bridge';
import { SKILL_SCRIPT_ERROR_CODES, SkillScriptError, isSkillScriptError, type SkillScriptErrorCode } from './contracts';

export const RUN_SKILL_SCRIPT_TOOL_NAME = 'run_canvas_skill_script';
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 32 * 1024 * 1024;
type ToolLoader = (context: AgentExecutionContext) => Promise<AgentTool[]>;
export type SkillScriptToolEffect = { toolName: string; result: AgentToolResult<unknown> };

const outputSchema = z.object({
  sourcePath: z.string().min(1).max(1024), destinationPath: z.string().min(1).max(1024),
  overwrite: z.boolean().optional(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
const runSchema = z.object({
  scriptRef: z.string().min(1).max(256), arguments: z.record(z.string(), z.unknown()),
  selectedBindings: z.array(z.object({ alias: z.string().min(1).max(64),
    toolRef: z.string().min(1).max(256), schemaRef: z.string().min(1).max(256) }).strict()).max(16).default([]),
  outputs: z.array(outputSchema).max(32).default([]),
}).strict();
export type SkillScriptRunInput = z.input<typeof runSchema>;
export type SkillScriptRunResult = {
  scriptRef: string; id: string; runtime: 'node' | 'python'; stdout: string; stderr: string;
  publishedRevisionRef: string; checksum: string;
  files: AgentFileChangeResult[]; toolResults: SkillScriptToolEffect[];
};

export class SkillScriptRunError extends SkillScriptError {
  constructor(code: SkillScriptErrorCode, readonly toolResults: SkillScriptToolEffect[], readonly terminateAgentTurn: boolean,
    readonly completedFiles: AgentFileChangeResult[] = []) {
    super(code, 'The skill script could not complete. Check its readiness and current permissions.', 409);
  }
}

/** Reload the exact persisted actor/workspace and retain only their issued old package revision. */
export async function refreshSkillScriptContext(context: AgentExecutionContext): Promise<AgentExecutionContext> {
  if (!context.userId?.trim() || !context.sessionId?.trim() || !context.agentId?.trim()) {
    throw new SkillScriptError('SCRIPT_ACCESS_DENIED', 'An authenticated agent session is required.', 403);
  }
  const fresh = await resolveAgentExecutionContextForStoredSession({ userId: context.userId,
    sessionId: context.sessionId, agentId: context.agentId, permissions: ['canRead', 'canRunAgent'] });
  if (fresh.workspaceId !== context.workspaceId || fresh.organizationId !== context.organizationId
    || fresh.workspaceRoot !== context.workspaceRoot || fresh.projectId !== context.projectId
    || fresh.customerId !== context.customerId) {
    throw new SkillScriptError('SCRIPT_ACCESS_DENIED', 'The script session workspace changed.', 403);
  }
  return reissueCapabilityPackageRuntimeBindings(context, { ...fresh, agentTurnId: context.agentTurnId });
}

export async function listSkillScriptActions(context: AgentExecutionContext, loadTools: ToolLoader) {
  const fresh = await refreshSkillScriptContext(context);
  const [scripts, tools] = await Promise.all([listAuthorizedSkillScripts(fresh), loadTools(fresh)]);
  const names = new Set(getProgressiveGatewayCapabilityNames(tools));
  return Promise.all(scripts.map(async script => {
    const readiness = await probeSkillScriptRuntime({ runtime: script.declaration.runtime });
    const executable = names.has(RUN_SKILL_SCRIPT_TOOL_NAME) && script.declaration.tools.every(requirement => requirement.kind === 'native'
      ? names.has(requirement.toolName) && isSkillScriptNativeToolAllowed(requirement.toolName) : names.has('integrations'));
    return { scriptRef: script.scriptRef, skillName: script.binding.skillName, id: script.declaration.id,
      displayName: script.declaration.displayName || script.declaration.id, description: script.declaration.description || '',
      runtime: script.declaration.runtime, publishedRevisionRef: script.binding.publishedRevisionRef,
      readiness: executable ? readiness : { ...readiness, available: false, code: 'SCRIPT_TOOL_DENIED',
        message: 'Enable the restricted script tool and its declared tool requirements for this agent before running.' },
      requiresBindings: script.declaration.tools.filter(requirement => requirement.kind === 'integration').map(requirement => requirement.alias) };
  }));
}

export async function describeSkillScriptAction(context: AgentExecutionContext, scriptRef: string, loadTools: ToolLoader) {
  const fresh = await refreshSkillScriptContext(context), script = await authorizeSkillScript(fresh, scriptRef);
  const metadata = (await listSkillScriptActions(context, loadTools)).find(entry => entry.scriptRef === scriptRef);
  if (!metadata) throw new SkillScriptError('SCRIPT_ACCESS_DENIED', 'The selected script is no longer available.', 403);
  return { scriptRef: script.scriptRef, skillName: script.binding.skillName, id: script.declaration.id,
    runtime: script.declaration.runtime, inputSchema: script.declaration.argumentsSchema,
    toolRequirements: script.declaration.tools, outputs: script.declaration.outputs,
    publishedRevisionRef: script.binding.publishedRevisionRef,
    readiness: metadata.readiness, requiresBindings: metadata.requiresBindings };
}

async function readOutput(root: string, relative: string): Promise<Buffer> {
  const normalized = normalizeCapabilityPackageRelativePath(relative);
  const actualRoot = await fs.realpath(root);
  let target = actualRoot;
  for (const part of normalized.split('/')) {
    target = path.join(target, part);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (target !== path.join(actualRoot, normalized) && !stat.isDirectory())) {
      throw new SkillScriptError('SCRIPT_OUTPUT_INVALID', 'A script output must remain inside its private run directory.');
    }
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > MAX_OUTPUT_BYTES
    || await fs.realpath(target) !== target) {
    throw new SkillScriptError('SCRIPT_OUTPUT_INVALID', 'A script output must be a bounded regular file.');
  }
  const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      throw new SkillScriptError('SCRIPT_OUTPUT_INVALID', 'The script output changed before publication.');
    }
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const final = await file.stat();
    if (count !== opened.size || final.size !== opened.size || final.nlink !== 1
      || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) {
      throw new SkillScriptError('SCRIPT_OUTPUT_INVALID', 'The script output changed.');
    }
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}

async function removeOwnRunDirectory(scratchParent: string, runDirectory: string): Promise<void> {
  const parent = await fs.realpath(scratchParent), stat = await fs.lstat(runDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.dirname(runDirectory) !== parent
    || !/^skill-script-[A-Za-z0-9]+$/u.test(path.basename(runDirectory)) || await fs.realpath(runDirectory) !== runDirectory) {
    throw new SkillScriptError('SCRIPT_OUTPUT_INVALID', 'The private script directory cannot be safely removed.');
  }
  await fs.rm(runDirectory, { recursive: true });
}

/** Installation/manifest declarations never grant tools. Every RPC intersects the current agent selection. */
export async function runSkillScriptAction(input: {
  context: AgentExecutionContext; arguments: unknown; loadTools: ToolLoader; signal?: AbortSignal;
}): Promise<SkillScriptRunResult> {
  const parsed = runSchema.safeParse(input.arguments);
  if (!parsed.success) throw new SkillScriptError('SCRIPT_ARGUMENTS_INVALID', 'The script request has invalid fields.');
  const request = parsed.data, scriptArguments = cloneIntegrationArguments(request.arguments);
  if (Buffer.byteLength(JSON.stringify(scriptArguments), 'utf8') > MAX_ARGUMENT_BYTES) {
    throw new SkillScriptError('SCRIPT_ARGUMENTS_INVALID', 'The script arguments are too large.');
  }
  const fresh = await refreshSkillScriptContext(input.context), script = await authorizeSkillScript(fresh, request.scriptRef);
  const revalidate = async () => {
    const current = await refreshSkillScriptContext(input.context);
    const authorized = await authorizeSkillScript(current, request.scriptRef);
    if (authorized.manifestChecksum !== script.manifestChecksum || authorized.entryPath !== script.entryPath) {
      throw new SkillScriptError('SCRIPT_PACKAGE_CHANGED', 'The held script declaration changed.', 409);
    }
    const tools = await input.loadTools(current);
    if (!getProgressiveGatewayCapabilityNames(tools).includes(RUN_SKILL_SCRIPT_TOOL_NAME)) {
      throw new SkillScriptError('SCRIPT_TOOL_DENIED', 'This agent cannot run the skill script.', 403);
    }
    if (await isPersistedIntegrationTurnUncertain(current)) {
      throw new SkillScriptError('SCRIPT_OUTCOME_UNKNOWN', 'The current turn has an unresolved tool outcome.', 409);
    }
    return current;
  };
  await revalidate();
  try { await validateIntegrationArguments(script.declaration.argumentsSchema, scriptArguments); }
  catch { throw new SkillScriptError('SCRIPT_ARGUMENTS_INVALID', 'The arguments do not match this script entrypoint.'); }
  const sources = new Set<string>(), destinations = new Set<string>();
  for (const output of request.outputs) {
    const source = normalizeCapabilityPackageRelativePath(output.sourcePath), destination = normalizeCapabilityPackageRelativePath(output.destinationPath);
    if (!script.declaration.outputs.includes(source) || sources.has(source) || destinations.has(destination)) {
      throw new SkillScriptError('SCRIPT_OUTPUT_INVALID', 'Choose distinct declared script outputs and workspace destinations.');
    }
    sources.add(source); destinations.add(destination);
  }
  if (request.outputs.length && !fresh.canWrite) throw new SkillScriptError('SCRIPT_ACCESS_DENIED', 'Workspace file writes are unavailable.', 403);
  const controller = new AbortController();
  let terminateAgentTurn = false;
  let stoppedCode: SkillScriptErrorCode | null = null;
  const abort = () => controller.abort(input.signal?.reason);
  const bridge = createSkillScriptToolBridge({ entry: script.declaration, scriptRef: script.scriptRef, context: fresh,
    selectedBindings: request.selectedBindings, loadTools: input.loadTools, revalidate, signal: controller.signal,
    onTerminate: reason => {
      terminateAgentTurn = reason === 'SCRIPT_OUTCOME_UNKNOWN';
      stoppedCode = SKILL_SCRIPT_ERROR_CODES.includes(reason as SkillScriptErrorCode)
        ? reason as SkillScriptErrorCode : 'SCRIPT_EXECUTION_FAILED';
      controller.abort();
    } });
  if (input.signal?.aborted) abort(); else input.signal?.addEventListener('abort', abort, { once: true });
  let scratchParent: string | null = null, runDirectory: string | null = null, release: (() => void) | null = null;
  const files: AgentFileChangeResult[] = [];
  try {
    await bridge.prepare();
    const readiness = await probeSkillScriptRuntime({ runtime: script.declaration.runtime });
    if (!readiness.available) throw new SkillScriptError(readiness.sandboxMode ? 'SCRIPT_RUNTIME_UNAVAILABLE' : 'SCRIPT_SANDBOX_UNAVAILABLE', 'The required restricted runtime is unavailable.', 503);
    scratchParent = await prepareScratchDirectory(fresh); release = acquireAgentRuntimeTempLease(scratchParent);
    const process = await executeSkillScriptProcess({ declaration: script.declaration, packageRoot: script.packageRoot,
      entryPath: script.entryPath, scratchParent, arguments: scriptArguments, signal: controller.signal,
      onRequest: raw => bridge.handle(raw), revalidate: async () => { await revalidate(); },
      onStop: () => controller.abort() });
    runDirectory = process.scratchDirectory;
    if (terminateAgentTurn || process.terminated || process.exitCode !== 0) {
      throw new SkillScriptError(stoppedCode || 'SCRIPT_EXECUTION_FAILED', 'The restricted script stopped.', 409);
    }
    const current = await revalidate(), pendingOutputs = [];
    let total = 0;
    for (const output of request.outputs) {
      const bytes = await readOutput(runDirectory, output.sourcePath); total += bytes.length;
      if (total > MAX_TOTAL_OUTPUT_BYTES) throw new SkillScriptError('SCRIPT_LIMIT_EXCEEDED', 'Script outputs exceed the publication limit.');
      pendingOutputs.push({ output, bytes });
    }
    for (const { output, bytes } of pendingOutputs) {
      const permission = await revalidate();
      if (!permission.canWrite || !current.canWrite) throw new SkillScriptError('SCRIPT_ACCESS_DENIED', 'Workspace write access was revoked.', 403);
      files.push(await runWithAgentExecutionContext(permission, () => writeAgentBinaryFile({ path: output.destinationPath,
        content: bytes, expectedSha256: output.expectedSha256, overwrite: output.overwrite, operation: 'skill_script_output' })));
    }
    return { scriptRef: script.scriptRef, id: script.declaration.id, runtime: script.declaration.runtime.kind,
      publishedRevisionRef: script.binding.publishedRevisionRef, checksum: script.binding.checksum,
      stdout: process.stdout, stderr: process.stderr, files, toolResults: bridge.results };
  } catch (failure) {
    throw new SkillScriptRunError(terminateAgentTurn ? 'SCRIPT_OUTCOME_UNKNOWN'
      : stoppedCode || (isSkillScriptError(failure) ? failure.code : 'SCRIPT_EXECUTION_FAILED'), bridge.results, terminateAgentTurn, files);
  } finally {
    bridge.close(); input.signal?.removeEventListener('abort', abort);
    try {
      if (scratchParent && runDirectory) {
        try { await removeOwnRunDirectory(scratchParent, runDirectory); }
        catch { console.warn('[SkillScript] Private run cleanup could not be confirmed; retained for scoped temporary-file recovery.'); }
      }
    }
    finally { release?.(); }
  }
}
