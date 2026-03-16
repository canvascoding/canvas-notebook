import { resolveAgentStorageDir } from '../runtime-data-paths';

export const MANAGED_PROMPT_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;

const AGENT_STORAGE_DIR = resolveAgentStorageDir();

export type ManagedPromptFileName = (typeof MANAGED_PROMPT_FILE_NAMES)[number];
export type ManagedPromptFiles = Record<ManagedPromptFileName, string>;

export const BASE_AGENT_SYSTEM_PROMPT =
  'You are an AI assistant in Canvas Notebook. You have access to the local workspace.';

export const FILE_SEARCH_GUIDANCE = `
## File Search Strategy (CRITICAL)

You have access to a powerful search tool called **qmd** (Quick Markdown Search) that indexes the entire workspace. Use it correctly:

### When to use qmd (ALWAYS for searching):
- Finding files by name or content
- Searching through documents for specific text
- Looking for related documents or notes
- Any query like "find...", "search...", "where is...", "suche...", "finde..."
- Semantic/conceptual searches ("documents about X", "related to Y")

### When to use ls (ONLY for directory listing):
- ONLY when the user explicitly asks to "list contents of folder X" or "show me what's in directory Y"
- NEVER use ls to find files - use qmd instead

### qmd Usage:
- **Default**: \`qmd search "query"\` - Fast keyword search (BM25), returns instantly
- **Semantic**: \`qmd vsearch "concept"\` - When keyword search fails and semantic similarity is needed (slower, ~1 min)
- **Avoid**: \`qmd query\` - Hybrid search with LLM reranking, often slower than vsearch

### Indexing Context:
qmd runs as a background service with automatic indexing:
- **Update**: Every 30 minutes (re-indexes changed files)
- **Embed**: Daily at 01:00 (semantic embeddings for vsearch)
- Collection: \`workspace\` covering \`/data/workspace/**/*\`

**Rule of thumb**: If you're looking FOR something, use qmd. If you're listing WHAT'S IN a specific folder, use ls.`;

export const TEMP_DIRECTORY_GUIDANCE = `
## Temporary Files Directory

When using skills that generate files (docx, xlsx, pdf, etc.), follow this workflow:

1. **Working Directory**: Use \`/data/temp/skills/{skill-name}/\` for temporary files during processing
   - Example: \`/data/temp/skills/docx/\` for DOCX skill temporary files
   - Example: \`/data/temp/skills/xlsx/\` for XLSX skill temporary files

2. **Final Output**: ALWAYS copy completed files to the workspace:
   - Target: \`/data/workspace/\` or appropriate subdirectories
   - Examples: \`/data/workspace/documents/\`, \`/data/workspace/reports/\`

3. **Cleanup**: Remove temporary files after successful completion to save space

**Important**: The user can ONLY see files in the workspace. Files in temp directories are invisible to users.`;

export const MEMORY_MANAGEMENT_GUIDANCE = `
## Memory Management (MEMORY.md)

**Location**: ${AGENT_STORAGE_DIR}/MEMORY.md

You MUST actively maintain this file throughout the conversation:

### Keep it COMPACT
- Only persist truly important user information
- Avoid storing temporary or session-specific details
- Focus on: preferences, recurring patterns, important long-term context

### UPDATE regularly
- Add new insights about the user as they emerge
- Consolidate related information to avoid duplication
- Use concise bullet points

### REMOVE irrelevant content
- Delete outdated information you no longer consider important
- Remove temporary context that has become obsolete
- Prune entries that don't provide lasting value

**WARNING**: Failure to maintain this file will result in an ever-growing system prompt, degrading performance. Be ruthless about keeping only what matters.`;

const MANAGED_FILES_INTRO =
  'The following agent-managed files define your runtime behavior, memory, tone, and tool guidance.';

export type ManagedPromptDiagnostics = {
  loadedFiles: ManagedPromptFileName[];
  includedFiles: ManagedPromptFileName[];
  emptyFiles: ManagedPromptFileName[];
  usedFallback: boolean;
  fallbackReason: 'all-empty' | 'read-failed' | null;
};

export type ManagedSystemPromptResult = {
  systemPrompt: string;
  diagnostics: ManagedPromptDiagnostics;
};

export function composeManagedAgentSystemPrompt(
  files: ManagedPromptFiles,
  skillsContext?: string
): ManagedSystemPromptResult {
  const sections = MANAGED_PROMPT_FILE_NAMES.map((fileName) => {
    const rawContent = files[fileName] ?? '';
    const content = rawContent.trim();

    return {
      fileName,
      content,
    };
  });

  const includedSections = sections.filter((section) => section.content.length > 0);

  if (includedSections.length === 0) {
    return {
      systemPrompt: BASE_AGENT_SYSTEM_PROMPT,
      diagnostics: {
        loadedFiles: [...MANAGED_PROMPT_FILE_NAMES],
        includedFiles: [],
        emptyFiles: [...MANAGED_PROMPT_FILE_NAMES],
        usedFallback: true,
        fallbackReason: 'all-empty',
      },
    };
  }

  const sectionBlocks = includedSections.map(
    (section) => `## ${section.fileName}\n${section.content}`
  );

  // Add skills context if provided
  const skillsBlock = skillsContext ? `\n\n${skillsContext}` : '';

  // Add file search guidance
  const fileSearchBlock = `\n\n${FILE_SEARCH_GUIDANCE}`;

  // Add temp directory guidance
  const tempBlock = `\n\n${TEMP_DIRECTORY_GUIDANCE}`;

  // Add memory management guidance
  const memoryBlock = `\n\n${MEMORY_MANAGEMENT_GUIDANCE}`;

  return {
    systemPrompt: [BASE_AGENT_SYSTEM_PROMPT, MANAGED_FILES_INTRO, ...sectionBlocks].join('\n\n') + skillsBlock + fileSearchBlock + tempBlock + memoryBlock,
    diagnostics: {
      loadedFiles: [...MANAGED_PROMPT_FILE_NAMES],
      includedFiles: includedSections.map((section) => section.fileName),
      emptyFiles: sections.filter((section) => section.content.length === 0).map((section) => section.fileName),
      usedFallback: false,
      fallbackReason: null,
    },
  };
}
