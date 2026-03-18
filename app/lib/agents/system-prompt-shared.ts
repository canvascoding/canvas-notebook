import { resolveAgentStorageDir } from '../runtime-data-paths';

export const MANAGED_PROMPT_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;

const AGENT_STORAGE_DIR = resolveAgentStorageDir();

export type ManagedPromptFileName = (typeof MANAGED_PROMPT_FILE_NAMES)[number];
export type ManagedPromptFiles = Record<ManagedPromptFileName, string>;

export const BASE_AGENT_SYSTEM_PROMPT =
  'You are an AI assistant in Canvas Notebook. You have access to the local workspace.';

export const FILE_SEARCH_GUIDANCE = `
## File Search Strategy (CRITICAL)

You have access to a workspace search tool called **qmd**. Use the tool, not shell snippets, whenever you need to find files or content across the workspace.

### When to use qmd (ALWAYS for searching):
- Finding files by name or content
- Searching through documents for specific text
- Looking for related documents or notes
- Any query like "find...", "search...", "where is...", "suche...", "finde..."
- Semantic/conceptual searches ("documents about X", "related to Y")

### When to use ls (ONLY for directory listing):
- ONLY when the user explicitly asks to "list contents of folder X" or "show me what's in directory Y"
- NEVER use ls to find files - use qmd instead

### qmd Tool Contract:
- Call the PI tool as \`qmd({ query, mode, limit, collection })\`
- **Default mode**: \`search\` for fast BM25 keyword lookup
- **Fallback mode**: \`vsearch\` only after weak or empty keyword results
- **Avoid by default**: \`query\` is expensive in this environment and can trigger model downloads/builds

### Indexing Context:
qmd runs as a background service with automatic indexing:
- **Update**: Every 30 minutes (re-indexes text files and regenerated derived docs)
- **Embed**: Daily at 01:00 (semantic embeddings for optional vsearch use)
- **Collections**: \`workspace-text\` for direct text files and \`workspace-derived\` for derived document text such as DOCX extracts

**Rule of thumb**: If you're looking FOR something, use qmd. If you're listing WHAT'S IN a specific folder, use ls. After qmd returns candidates, use \`read\` only on the specific files you want to inspect.`;

export const FILE_SYSTEM_GUIDANCE = `
## File System Structure

See AGENTS.md for the complete directory structure diagram with Mermaid visualization.

**Key Rules:**
- User sees ONLY \`/data/workspace/\` in the Web UI
- Use \`/data/temp/skills/{skill-name}/\` for temporary processing files
- ALWAYS copy final results to \`/data/workspace/\`
- Clean up temp files after completion

**Note:** You can update AGENTS.md to document the current workspace structure as you learn about user-specific folders.`;

export const TEMP_DIRECTORY_GUIDANCE = `
## Temporary Files Directory

See AGENTS.md for detailed file system structure and workflow.`;

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

  // Add file system guidance (compact)
  const fileSystemBlock = `\n\n${FILE_SYSTEM_GUIDANCE}`;

  // Add temp directory guidance
  const tempBlock = `\n\n${TEMP_DIRECTORY_GUIDANCE}`;

  // Add memory management guidance
  const memoryBlock = `\n\n${MEMORY_MANAGEMENT_GUIDANCE}`;

  return {
    systemPrompt: [BASE_AGENT_SYSTEM_PROMPT, MANAGED_FILES_INTRO, ...sectionBlocks].join('\n\n') + skillsBlock + fileSearchBlock + fileSystemBlock + tempBlock + memoryBlock,
    diagnostics: {
      loadedFiles: [...MANAGED_PROMPT_FILE_NAMES],
      includedFiles: includedSections.map((section) => section.fileName),
      emptyFiles: sections.filter((section) => section.content.length === 0).map((section) => section.fileName),
      usedFallback: false,
      fallbackReason: null,
    },
  };
}
