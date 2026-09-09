import 'server-only';

import { cleanWebText, clampWebInteger } from '@/app/lib/integrations/web-content-service';
import { storeToolOutput, type ToolOutputIdentity } from './tool-output-store';
import { formatWebSourceList, type WebOutputSource } from './tool-output-format';
import type { ToolOutputMetadata } from './tool-output-metadata';
import { markPreparedToolOutput } from './prepared-tool-output';
import {
  TOOL_OUTPUT_PAGE_MAX_CHARACTERS,
  TOOL_OUTPUT_PAGE_MAX_CHARACTERS_PER_PAGE,
  TOOL_OUTPUT_POLICY_VERSION,
  TOOL_OUTPUT_SEARCH_MAX_CHARACTERS,
} from './tool-output-policy';

export async function prepareWebToolOutput(input: {
  sources: WebOutputSource[];
  kind: 'search' | 'pages';
  heading: string;
  provider: string;
  identity: ToolOutputIdentity | null;
  toolCallId: string;
  maxContentLength?: number;
}) {
  const metadata: ToolOutputMetadata = {
    version: 1, policyVersion: TOOL_OUTPUT_POLICY_VERSION,
    rawChars: 0, modelChars: 0, storedBytes: 0, references: [],
    sourceCount: input.sources.length,
  };
  const sources: WebOutputSource[] = [];
  for (const source of input.sources.slice(0, input.kind === 'search' ? 20 : 10)) {
    // Provider fields never supply references. Only successful writes create them.
    const clean: WebOutputSource = {
      title: source.title, url: source.url,
      ...(source.snippet ? { snippet: cleanWebText(source.snippet) } : {}),
      ...(source.content ? { content: cleanWebText(source.content) } : {}),
      ...(source.error ? { error: source.error } : {}),
      ...(source.statusCode ? { statusCode: source.statusCode } : {}),
      ...(source.finalUrl ? { finalUrl: source.finalUrl } : {}),
    };
    const serialized = JSON.stringify(clean);
    metadata.rawChars += serialized.length;
    if (input.identity) {
      const stored = await storeToolOutput({
        identity: input.identity, toolCallId: input.toolCallId, content: serialized, format: 'json',
        source: { title: clean.title, url: clean.url, provider: input.provider },
      });
      if (stored.ok) {
        clean.reference = stored.reference;
        metadata.references.push({ reference: stored.reference, manifestReference: stored.manifestReference, bytes: stored.bytes, characters: stored.characters, sha256: stored.sha256, complete: stored.complete });
        metadata.storedBytes += stored.bytes;
      } else metadata.storageError = stored.error;
    } else metadata.storageError = 'No active session; full source output is unavailable.';
    sources.push(clean);
  }
  const storageNotice = metadata.storageError ? `\nFull source storage unavailable: ${metadata.storageError}\n` : '';
  const maxChars = input.kind === 'search' ? TOOL_OUTPUT_SEARCH_MAX_CHARACTERS : TOOL_OUTPUT_PAGE_MAX_CHARACTERS;
  const formatted = formatWebSourceList(sources, {
    heading: input.heading, kind: input.kind, maxChars: maxChars - storageNotice.length,
    maxContentChars: clampWebInteger(input.maxContentLength, TOOL_OUTPUT_PAGE_MAX_CHARACTERS_PER_PAGE, TOOL_OUTPUT_PAGE_MAX_CHARACTERS_PER_PAGE),
    sourceCount: input.sources.length,
  });
  const text = formatted.text + storageNotice;
  metadata.modelChars = text.length;
  metadata.shownCount = formatted.shownCount;
  metadata.omittedCount = formatted.omittedCount;
  metadata.excerpted = formatted.truncated;
  return markPreparedToolOutput({ content: [{ type: 'text' as const, text }], details: { toolOutput: metadata } });
}
