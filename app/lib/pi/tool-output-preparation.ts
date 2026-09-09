import 'server-only';

import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { storeToolOutput, type ToolOutputIdentity } from './tool-output-store';
import type { ToolOutputMetadata } from './tool-output-metadata';
import { headTailToolText, clipToolText } from './tool-output-format';
import { isPreparedToolOutput, markPreparedToolOutput } from './prepared-tool-output';
import { TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS, TOOL_OUTPUT_LARGE_RESULT_PREVIEW_CHARACTERS, TOOL_OUTPUT_POLICY_VERSION } from './tool-output-policy';

export type ToolOutputPreparationContext = { identity: ToolOutputIdentity | null; toolCallId: string };

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? `${entry}n` : entry) ?? 'null';
}

/** Preserve small UI fields, without copying large nested provider payloads. */
function compactDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const retained: Record<string, unknown> = {};
  let remaining = 4_000;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'toolOutput') continue;
    let size: number;
    try { size = stringify({ [key]: entry }).length; } catch { continue; }
    if (size <= 1_000 && size <= remaining) {
      retained[key] = entry;
      remaining -= size;
    }
  }
  return retained;
}

/** Surface bounded status/auth/mutation identifiers even when the body is huge. */
function collectOutcomeFields(values: unknown[], maxChars: number): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let remaining = maxChars;
  let visited = 0;
  const visit = (entry: unknown, prefix: string, depth: number) => {
    if (!entry || typeof entry !== 'object' || depth > 6 || visited++ >= 2_000) return;
    const entries = Object.entries(entry);
    // Inspect an envelope's scalar outcome before traversing a large data array.
    for (const [key, nested] of entries) {
      if (remaining <= 0) break;
      const field = prefix ? `${prefix}.${key}` : key;
      const opaqueIdentifier = /(?:id|Id|ID|url|Url|URL|uri|Uri|URI)$/u.test(key);
      if ((opaqueIdentifier || /^(?:isError|error|success|successful|status|code|auth_required|redirect_url|toolkit|toolkit_name|tool_name|profile_name|profile_source|connected|mutates|sha256|hash|sceneSequence|version|versionNonce)$/u.test(key))
        && (typeof nested === 'string' || typeof nested === 'boolean' || typeof nested === 'number')) {
        // Opaque identifiers and URLs must remain exact for follow-up actions.
        const text = typeof nested === 'string' && !opaqueIdentifier ? clipToolText(nested, 300) : nested;
        const size = stringify({ [field]: text }).length;
        if (size <= remaining) { fields[field] = text; remaining -= size; }
      }
    }
    for (const [key, nested] of entries) {
      if (remaining <= 0 || visited >= 2_000) break;
      if (nested && typeof nested === 'object') visit(nested, prefix ? `${prefix}.${key}` : key, depth + 1);
    }
  };
  for (const value of values) visit(value, '', 0);
  return fields;
}

export async function prepareToolOutput(input: ToolOutputPreparationContext & {
  result: AgentToolResult<unknown>;
  toolName: string;
  raw?: unknown;
  maxChars?: number;
}): Promise<AgentToolResult<unknown>> {
  let { result } = input;
  if (isPreparedToolOutput(result)) return result;
  if (result.details && typeof result.details === 'object' && ('toolOutput' in result.details || 'toolOutputView' in result.details)) {
    const details = { ...result.details } as Record<string, unknown>;
    delete details.toolOutput;
    delete details.toolOutputView;
    result = { ...result, details };
  }
  // Built-in saved reads already have exact offset budgets; never create a read loop.
  if (input.toolName === 'read' && (result.details as { toolOutputReadWindow?: unknown } | null)?.toolOutputReadWindow) return result;
  if (input.toolName === 'read' && (result.details as { toolOutputRead?: boolean } | null)?.toolOutputRead === true) return result;
  const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  const limit = Math.max(256, Math.min(TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS, Math.floor(input.maxChars || TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS)));
  let serialized: string;
  let detailSize: number;
  try {
    serialized = stringify(input.raw === undefined ? result : input.raw);
    detailSize = stringify(result.details).length;
  } catch {
    const modelText = `Original output unavailable: serialization failed.\n${headTailToolText(text, Math.min(1_500, limit - 100))}`;
    return markPreparedToolOutput({ ...result, content: [
      { type: 'text', text: modelText },
      ...result.content.filter(block => block.type !== 'text'),
    ], details: { ...compactDetails(result.details), toolOutput: {
      version: 1, policyVersion: TOOL_OUTPUT_POLICY_VERSION, rawChars: text.length, modelChars: modelText.length, storedBytes: 0,
      references: [], storageError: 'Original output could not be serialized.',
    } } });
  }
  // Images remain on their separate multimodal path, not the text budget.
  let parsedText: unknown;
  try { parsedText = JSON.parse(text); } catch { parsedText = null; }
  const outcomeFields = collectOutcomeFields([input.raw, parsedText, result.details], 3_000);
  if (text.length <= limit && detailSize <= TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS) {
    return markPreparedToolOutput({ ...result, details: {
      ...(result.details && typeof result.details === 'object' ? result.details : { value: result.details }),
      toolOutput: { version: 1, policyVersion: TOOL_OUTPUT_POLICY_VERSION, rawChars: serialized.length,
        modelChars: text.length, storedBytes: 0, references: [], outcomeFields },
    } });
  }

  const metadata: ToolOutputMetadata = {
    version: 1, policyVersion: TOOL_OUTPUT_POLICY_VERSION, rawChars: serialized.length,
    modelChars: 0, storedBytes: 0, references: [],
    outcomeFields,
  };
  if (input.identity) {
    const stored = await storeToolOutput({ identity: input.identity, toolCallId: input.toolCallId, content: serialized, format: 'json' });
    if (stored.ok) {
      const { reference, manifestReference, bytes, characters, sha256, complete } = stored;
      metadata.references.push({ reference, manifestReference, bytes, characters, sha256, complete });
      metadata.storedBytes = bytes;
    } else metadata.storageError = stored.error;
  } else metadata.storageError = 'No active session; full output is unavailable.';

  const notice = metadata.references.length
    ? `Full original JSON: ${metadata.references[0].reference}\nUse read with offset or rg to inspect omitted content.`
    : `Full output unavailable: ${metadata.storageError}`;
  const outcome = collectOutcomeFields([input.raw, parsedText, result.details], Math.min(3_000, Math.max(0, limit - notice.length - 120)));
  const auth = parsedText && typeof parsedText === 'object' && (parsedText as Record<string, unknown>).auth_required === true;
  // Auth consumers parse the tool text as JSON; keep that established contract.
  const render = (preview: string) => auth
    ? stringify({ ...outcome, output_excerpt: preview, output_notice: notice })
    : [Object.keys(outcome).length ? `Outcome fields: ${stringify(outcome)}` : '', notice, 'Text excerpt (not complete JSON):', preview].filter(Boolean).join('\n');
  let previewChars = Math.min(TOOL_OUTPUT_LARGE_RESULT_PREVIEW_CHARACTERS, Math.max(0, limit - render('').length));
  let modelText = render(headTailToolText(text, previewChars));
  // JSON escaping has variable expansion. Measure the actual returned text.
  while (modelText.length > limit && previewChars > 0) {
    previewChars = Math.max(0, previewChars - Math.max(1, Math.ceil((modelText.length - limit) / 6)));
    modelText = render(headTailToolText(text, previewChars));
  }
  metadata.modelChars = modelText.length;
  return markPreparedToolOutput({ ...result,
    content: [{ type: 'text', text: modelText }, ...result.content.filter(block => block.type !== 'text')],
    details: { ...compactDetails(result.details), toolOutput: metadata },
  });
}
