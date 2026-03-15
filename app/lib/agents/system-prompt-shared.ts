export const MANAGED_PROMPT_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;

export type ManagedPromptFileName = (typeof MANAGED_PROMPT_FILE_NAMES)[number];
export type ManagedPromptFiles = Record<ManagedPromptFileName, string>;

export const BASE_AGENT_SYSTEM_PROMPT =
  'You are an AI assistant in Canvas Notebook. You have access to the local workspace.';

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
  
  // Add temp directory guidance
  const tempBlock = `\n\n${TEMP_DIRECTORY_GUIDANCE}`;

  return {
    systemPrompt: [BASE_AGENT_SYSTEM_PROMPT, MANAGED_FILES_INTRO, ...sectionBlocks].join('\n\n') + skillsBlock + tempBlock,
    diagnostics: {
      loadedFiles: [...MANAGED_PROMPT_FILE_NAMES],
      includedFiles: includedSections.map((section) => section.fileName),
      emptyFiles: sections.filter((section) => section.content.length === 0).map((section) => section.fileName),
      usedFallback: false,
      fallbackReason: null,
    },
  };
}
