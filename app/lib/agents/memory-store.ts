import 'server-only';

import {
  DEFAULT_MANAGED_AGENT_ID,
  readManagedAgentFile,
  writeManagedAgentFile,
  type AgentManagedFileName,
  type AgentStorageScope,
} from './storage';

export type MemoryTarget = 'agent' | 'user';
export type MemoryAction = 'read' | 'add' | 'update' | 'delete';

export type MemoryEntry = {
  id: string;
  content: string;
};

export type MemoryReadResult = {
  target: MemoryTarget;
  agentId: string;
  fileName: 'MEMORY.md' | 'USER.md';
  content: string;
  entries: MemoryEntry[];
  limit: number;
};

export type MemoryMutationResult = MemoryReadResult & {
  changed: boolean;
  entry?: MemoryEntry;
  deletedEntry?: MemoryEntry;
};

type MemoryScopeParams = {
  userId?: string | null;
};

type ParsedMemoryFile = {
  preamble: string;
  entries: MemoryEntry[];
};

const AGENT_MEMORY_LIMIT = 12_000;
const USER_MEMORY_LIMIT = 8_000;
const MAX_ENTRY_CHARS = 1_000;

const ENTRY_PATTERN = /^-\s+\[([A-Za-z0-9_-]+)]\s+(.+)$/;
const LEGACY_PLACEHOLDER_LINES = new Set([
  'Store only durable, useful facts about the user and their long-term preferences here.',
  'Insert here what you learn about the user.',
]);

const SECRET_PATTERNS = [
  /\b(?:api[_ -]?key|secret|token|password|passwd|credential)s?\b\s*[:=]/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
];

function normalizeMemoryAgentId(agentId?: string | null): string {
  const normalized = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
  return normalized || DEFAULT_MANAGED_AGENT_ID;
}

function resolveMemoryFile(target: MemoryTarget): { fileName: 'MEMORY.md' | 'USER.md'; limit: number } {
  return target === 'user'
    ? { fileName: 'USER.md', limit: USER_MEMORY_LIMIT }
    : { fileName: 'MEMORY.md', limit: AGENT_MEMORY_LIMIT };
}

function resolveStorageAgentId(target: MemoryTarget, agentId?: string | null): string {
  return target === 'user' ? DEFAULT_MANAGED_AGENT_ID : normalizeMemoryAgentId(agentId);
}

function normalizeEntryContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function normalizeForDedupe(content: string): string {
  return normalizeEntryContent(content).toLowerCase();
}

function assertValidEntryContent(content: string): string {
  const normalized = normalizeEntryContent(content);
  if (!normalized) {
    throw new Error('Memory content must not be empty.');
  }
  if (normalized.length > MAX_ENTRY_CHARS) {
    throw new Error(`Memory content must be ${MAX_ENTRY_CHARS} characters or less.`);
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error('Memory content appears to contain a secret or credential.');
  }
  return normalized;
}

function parseMemoryFile(content: string): ParsedMemoryFile {
  const preambleLines: string[] = [];
  const entries: MemoryEntry[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === '## Entries' || LEGACY_PLACEHOLDER_LINES.has(line)) {
      continue;
    }

    const match = line.match(ENTRY_PATTERN);
    if (match) {
      entries.push({
        id: match[1],
        content: match[2].trim(),
      });
      continue;
    }

    preambleLines.push(rawLine);
  }

  return {
    preamble: preambleLines.join('\n').trim(),
    entries,
  };
}

function serializeMemoryFile(parsed: ParsedMemoryFile): string {
  const blocks: string[] = [];
  if (parsed.preamble.trim()) {
    blocks.push(parsed.preamble.trim());
  }

  if (parsed.entries.length > 0) {
    blocks.push(['## Entries', '', ...parsed.entries.map((entry) => `- [${entry.id}] ${entry.content}`)].join('\n'));
  }

  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '';
}

function assertWithinLimit(content: string, limit: number): void {
  if (content.length > limit) {
    throw new Error(`Memory file would exceed ${limit} characters.`);
  }
}

function createMemoryId(content: string, existingIds: Set<string>): string {
  const slug = normalizeForDedupe(content)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'entry';

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const id = `mem_${slug}_${suffix}`;
    if (!existingIds.has(id)) {
      return id;
    }
  }

  throw new Error('Could not create a unique memory id.');
}

function resolveMemoryStorageScope(params?: MemoryScopeParams | null): AgentStorageScope | null {
  return params?.userId ? { userId: params.userId } : null;
}

async function readParsedMemory(
  target: MemoryTarget,
  agentId?: string | null,
  scope?: AgentStorageScope | null,
) {
  const { fileName, limit } = resolveMemoryFile(target);
  const storageAgentId = resolveStorageAgentId(target, agentId);
  const rawContent = await readManagedAgentFile(fileName as AgentManagedFileName, storageAgentId, scope);
  const parsed = parseMemoryFile(rawContent);
  return { fileName, limit, storageAgentId, parsed };
}

async function writeParsedMemory(
  agentId: string,
  fileName: 'MEMORY.md' | 'USER.md',
  limit: number,
  parsed: ParsedMemoryFile,
  scope?: AgentStorageScope | null,
): Promise<string> {
  const content = serializeMemoryFile(parsed);
  assertWithinLimit(content, limit);
  return writeManagedAgentFile(fileName as AgentManagedFileName, content, agentId, scope);
}

function toReadResult(
  target: MemoryTarget,
  agentId: string,
  fileName: 'MEMORY.md' | 'USER.md',
  limit: number,
  parsed: ParsedMemoryFile,
  content?: string,
): MemoryReadResult {
  return {
    target,
    agentId,
    fileName,
    content: content ?? serializeMemoryFile(parsed),
    entries: parsed.entries,
    limit,
  };
}

export async function readMemory(params: {
  target: MemoryTarget;
  agentId?: string | null;
} & MemoryScopeParams): Promise<MemoryReadResult> {
  const scope = resolveMemoryStorageScope(params);
  const { fileName, limit, storageAgentId, parsed } = await readParsedMemory(params.target, params.agentId, scope);
  return toReadResult(params.target, storageAgentId, fileName, limit, parsed);
}

export async function addMemory(params: {
  target: MemoryTarget;
  agentId?: string | null;
  content: string;
} & MemoryScopeParams): Promise<MemoryMutationResult> {
  const content = assertValidEntryContent(params.content);
  const scope = resolveMemoryStorageScope(params);
  const { fileName, limit, storageAgentId, parsed } = await readParsedMemory(params.target, params.agentId, scope);
  const normalized = normalizeForDedupe(content);
  const existing = parsed.entries.find((entry) => normalizeForDedupe(entry.content) === normalized);

  if (existing) {
    return {
      ...toReadResult(params.target, storageAgentId, fileName, limit, parsed),
      changed: false,
      entry: existing,
    };
  }

  const entry = {
    id: createMemoryId(content, new Set(parsed.entries.map((item) => item.id))),
    content,
  };
  const next = {
    ...parsed,
    entries: [...parsed.entries, entry],
  };
  const writtenContent = await writeParsedMemory(storageAgentId, fileName, limit, next, scope);

  return {
    ...toReadResult(params.target, storageAgentId, fileName, limit, next, writtenContent),
    changed: true,
    entry,
  };
}

export async function updateMemory(params: {
  target: MemoryTarget;
  agentId?: string | null;
  id: string;
  content: string;
} & MemoryScopeParams): Promise<MemoryMutationResult> {
  const id = params.id.trim();
  if (!id) {
    throw new Error('Memory id is required.');
  }

  const content = assertValidEntryContent(params.content);
  const scope = resolveMemoryStorageScope(params);
  const { fileName, limit, storageAgentId, parsed } = await readParsedMemory(params.target, params.agentId, scope);
  const index = parsed.entries.findIndex((entry) => entry.id === id);
  if (index < 0) {
    throw new Error(`Memory entry "${id}" was not found.`);
  }

  const normalized = normalizeForDedupe(content);
  const duplicate = parsed.entries.find((entry) => entry.id !== id && normalizeForDedupe(entry.content) === normalized);
  if (duplicate) {
    throw new Error(`Memory entry duplicates "${duplicate.id}".`);
  }

  const entry = { id, content };
  const nextEntries = [...parsed.entries];
  nextEntries[index] = entry;
  const next = { ...parsed, entries: nextEntries };
  const writtenContent = await writeParsedMemory(storageAgentId, fileName, limit, next, scope);

  return {
    ...toReadResult(params.target, storageAgentId, fileName, limit, next, writtenContent),
    changed: true,
    entry,
  };
}

export async function deleteMemory(params: {
  target: MemoryTarget;
  agentId?: string | null;
  id: string;
} & MemoryScopeParams): Promise<MemoryMutationResult> {
  const id = params.id.trim();
  if (!id) {
    throw new Error('Memory id is required.');
  }

  const scope = resolveMemoryStorageScope(params);
  const { fileName, limit, storageAgentId, parsed } = await readParsedMemory(params.target, params.agentId, scope);
  const deletedEntry = parsed.entries.find((entry) => entry.id === id);
  if (!deletedEntry) {
    throw new Error(`Memory entry "${id}" was not found.`);
  }

  const next = {
    ...parsed,
    entries: parsed.entries.filter((entry) => entry.id !== id),
  };
  const writtenContent = await writeParsedMemory(storageAgentId, fileName, limit, next, scope);

  return {
    ...toReadResult(params.target, storageAgentId, fileName, limit, next, writtenContent),
    changed: true,
    deletedEntry,
  };
}
