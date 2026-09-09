/** Small, serializable metadata. Complete provider payloads belong in the store. */
export type ToolOutputReference = {
  reference: string;
  manifestReference?: string;
  bytes: number;
  characters: number;
  sha256: string;
  complete: boolean;
  title?: string;
  provider?: string;
};

export type ToolOutputMetadata = {
  version: 1;
  policyVersion: string;
  rawChars: number;
  modelChars: number;
  storedBytes: number;
  references: ToolOutputReference[];
  storageError?: string;
  sourceCount?: number;
  shownCount?: number;
  omittedCount?: number;
};

export function getToolOutputMetadata(details: unknown): ToolOutputMetadata | null {
  if (!details || typeof details !== 'object') return null;
  const metadata = (details as { toolOutput?: unknown }).toolOutput;
  if (!metadata || typeof metadata !== 'object') return null;
  const value = metadata as Partial<ToolOutputMetadata>;
  if (value.version !== 1 || typeof value.policyVersion !== 'string' || !Array.isArray(value.references)) return null;
  if (!value.references.every((entry) => entry && typeof entry.reference === 'string' && entry.reference.startsWith('tool-output://'))) return null;
  return value as ToolOutputMetadata;
}

/** Fork only artifacts explicitly attached to copied results, never later output. */
export function collectStoredToolOutputReferences(messages: readonly { content: string }[]): string[] {
  const references = new Set<string>();
  for (const row of messages) {
    let message: { role?: string; details?: unknown };
    try { message = JSON.parse(row.content); } catch { continue; }
    if (message?.role !== 'toolResult') continue;
    for (const artifact of getToolOutputMetadata(message.details)?.references ?? []) {
      references.add(artifact.reference);
    }
  }
  return [...references];
}
