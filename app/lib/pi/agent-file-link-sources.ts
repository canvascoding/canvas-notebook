export type AgentFileLinkSource = {
  content: string;
  beforeContent?: string;
  basis: 'applied' | 'proposed' | 'current';
};

// Full source text belongs to this process, never to the public tool receipt.
const sources = new WeakMap<object, AgentFileLinkSource>();

export function captureAgentFileLinkSource<T extends object>(result: T, source: AgentFileLinkSource): T {
  const filePath = (result as { path?: unknown }).path;
  if (typeof filePath === 'string' && /\.(?:md|markdown|mdx)$/iu.test(filePath)) sources.set(result, source);
  return result;
}

export function getAgentFileLinkSource(result: object): AgentFileLinkSource | undefined {
  return sources.get(result);
}

export function takeAgentFileLinkSource(result: object): AgentFileLinkSource | undefined {
  const source = sources.get(result);
  sources.delete(result);
  return source;
}
