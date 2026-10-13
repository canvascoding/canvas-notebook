export type MarkdownExportMessage = Record<string, unknown>;

export type MarkdownExportOutput = {
  reference: string;
  content: string;
  complete: boolean;
};

function fence(text: string, language = ''): string {
  let length = 3;
  for (const run of text.matchAll(/`{3,}/g)) length = Math.max(length, run[0].length + 1);
  const delimiter = '`'.repeat(length);
  return `${delimiter}${language}\n${text}\n${delimiter}`;
}

function json(value: unknown): string {
  return fence(JSON.stringify(value, null, 2) ?? 'null', 'json');
}

function heading(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ');
}

function formatContent(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return content === undefined ? [] : [json(content)];
  return content.flatMap((part: unknown): string[] => {
    if (!part || typeof part !== 'object') return [json(part)];
    const block = part as Record<string, unknown>;
    if (block.type === 'toolCall') {
      const { arguments: input, ...metadata } = block;
      return [`### Tool call: ${heading(block.name)}`, json(metadata), '#### Input', json(input)];
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      const { type: _type, text, ...metadata } = block;
      return [text, ...(Object.keys(metadata).length ? [json(metadata)] : [])];
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const { type: _type, thinking, ...metadata } = block;
      return ['### Thinking', fence(thinking, 'text'), ...(Object.keys(metadata).length ? [json(metadata)] : [])];
    }
    // Retain images, attachments and future/custom blocks without losing fields.
    return [json(block)];
  });
}

/** No display projection, collapsed-row filtering, or text truncation. */
export function formatChatMarkdown(input: {
  title: string;
  sessionId: string;
  agentId: string;
  messages: MarkdownExportMessage[];
  storedOutputs: Map<string, MarkdownExportOutput[]>;
  warnings: string[];
}): string {
  const sections = [
    `# ${heading(input.title || 'Chat')}`,
    json({ sessionId: input.sessionId, agentId: input.agentId, messageCount: input.messages.length }),
    ...input.warnings.map((warning) => `> Export warning: ${heading(warning)}`),
  ];
  input.messages.forEach((message, index) => {
    const { content, details, ...metadata } = message;
    const role = message.role === 'toolResult' ? `Tool output: ${heading(message.toolName)}` : heading(message.role || 'Message');
    sections.push(`## ${index + 1}. ${role}`, ...formatContent(content));
    if (details !== undefined) sections.push('### Details', json(details));
    for (const output of input.storedOutputs.get(String(message.id)) ?? []) {
      sections.push('### Stored tool output', json({ reference: output.reference, complete: output.complete }));
      // Keep the original payload verbatim; nested Markdown fences stay intact.
      sections.push(fence(output.content, output.reference.endsWith('.json') ? 'json' : 'text'));
    }
    sections.push('### Message metadata', json(metadata));
  });
  return `${sections.join('\n\n')}\n`;
}
