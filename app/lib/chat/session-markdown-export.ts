import 'server-only';

import { stripMcpAppAuthority } from '@/app/lib/mcp/apps-contracts';
import { getToolOutputMetadata } from '@/app/lib/pi/tool-output-metadata';
import { readStoredToolOutput, type ToolOutputIdentity } from '@/app/lib/pi/tool-output-store';
import { formatChatMarkdown, type MarkdownExportMessage, type MarkdownExportOutput } from './markdown-export';

/** Expand archived outputs using the authorized session identity, never a client path. */
export async function exportSessionMarkdown(input: {
  title: string;
  sessionId: string;
  agentId: string;
  messages: MarkdownExportMessage[];
  identity?: ToolOutputIdentity;
}) {
  const storedOutputs = new Map<string, MarkdownExportOutput[]>();
  const outputCache = new Map<string, string>();
  const warnings: string[] = [];
  for (const message of input.messages) {
    if (message.role !== 'toolResult') continue;
    const metadata = getToolOutputMetadata(message.details);
    if (metadata?.storageError) warnings.push(`Original output unavailable for ${message.toolName}: ${metadata.storageError}`);
    for (const reference of metadata?.references ?? []) {
      if (!input.identity) throw new Error('Stored output requires a session identity.');
      let content = outputCache.get(reference.reference);
      if (content === undefined) {
        // A missing/unreadable archive fails the export instead of silently copying a preview.
        const stored = await readStoredToolOutput(input.identity, reference.reference);
        content = reference.reference.endsWith('.json')
          ? JSON.stringify(stripMcpAppAuthority(JSON.parse(stored.content)), null, 2)
          : stored.content;
        outputCache.set(reference.reference, content);
      }
      if (!reference.complete) warnings.push(`Stored source is incomplete: ${reference.reference}`);
      const key = String(message.id);
      const outputs = storedOutputs.get(key) ?? [];
      outputs.push({ reference: reference.reference, content, complete: reference.complete });
      storedOutputs.set(key, outputs);
    }
  }
  return {
    markdown: formatChatMarkdown({ ...input, messages: stripMcpAppAuthority(input.messages) as MarkdownExportMessage[], storedOutputs, warnings }),
    hasWarnings: warnings.length > 0,
  };
}
