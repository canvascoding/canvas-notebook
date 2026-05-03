import { resolveAgentStorageDir } from '../runtime-data-paths';

export const MANAGED_PROMPT_FILE_NAMES = ['AGENTS.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'] as const;

const AGENT_STORAGE_DIR = resolveAgentStorageDir();

export type ManagedPromptFileName = (typeof MANAGED_PROMPT_FILE_NAMES)[number];
export type ManagedPromptFiles = Record<ManagedPromptFileName, string>;

export const FILE_ACCESS_GUIDANCE = `
## File Access for Uploaded Attachments

When the user uploads files via the chat attachment feature (paperclip icon):

### Image Files
- Images are automatically converted to Base64 and embedded in the message
- You can analyze them directly without additional file access
- The original uploaded image is also provided with \`containerFilePath\` for copying, moving, or organizing it in the workspace

### Uploaded Files
- Every uploaded file is provided with a direct filesystem path key: \`containerFilePath: /data/user-uploads/{category}/{fileId}\`
- For non-image files, you MUST explicitly read these files using appropriate tools:
  - **CSV/JSON/TXT/MD/XML/YAML**: Use \`read_file\` tool directly
  - **PDF**: Use the \`pdf\` skill to read and extract content
  - **DOCX**: Use the \`docx\` skill or external tools
  - **Archives (ZIP, TAR, etc.)**: Extract first, then read contents
  - **Spreadsheets**: Use appropriate parsing tools

### Important
- You cannot access uploaded files via HTTP API endpoints
- Always use \`containerFilePath\` for direct filesystem access
- Choose the right tool/skill based on the file type indicated in the prompt`;

export const PLANNING_MODE_GUIDANCE = `## Planning Mode (ACTIVE)

You are currently operating in **Planning Mode**. This mode restricts you to read-only analysis — you may inspect the workspace, search files, and create plans, but you MUST NOT make any changes.

### Available tools in Planning Mode:
- \`web_fetch\` — fetch web content for research
- \`rg\` — search file contents
- \`ls\` — list directories
- \`read\` — read files
- \`glob\` — find files by pattern
- \`grep\` — search with grep
- \`qmd\` — semantic search
- \`list_automation_jobs\` — list scheduled jobs

### Strictly forbidden:
- \`write\` / \`bash\` / \`mkdir\` or any tool that modifies files, runs commands, or creates/deletes resources
- Do NOT attempt workarounds (e.g., using bash to write files)

### When the user wants changes made:
Acknowledge the request, outline what you would do, then ask the user to **switch back to Standard Mode** (Shift+Tab) so you can execute the changes.`;

const MANAGED_FILES_INTRO =
  `The following agent-managed files define your runtime behavior, memory, tone, and tool guidance. These files are stored in ${AGENT_STORAGE_DIR} and can be edited when the user asks.`;

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
    const skillsBlock = skillsContext ? `\n\n${skillsContext}` : '';
    const fileAccessBlock = `\n\n${FILE_ACCESS_GUIDANCE}`;

    return {
      systemPrompt: `${skillsBlock}${fileAccessBlock}`.trim(),
      diagnostics: {
        loadedFiles: [...MANAGED_PROMPT_FILE_NAMES],
        includedFiles: [],
        emptyFiles: [...MANAGED_PROMPT_FILE_NAMES],
        usedFallback: false,
        fallbackReason: null,
      },
    };
  }

  const sectionBlocks = includedSections.map(
    (section) => `## ${section.fileName}\nSource: ${AGENT_STORAGE_DIR}/${section.fileName}\n\n${section.content}`
  );

  // Add skills context if provided
  const skillsBlock = skillsContext ? `\n\n${skillsContext}` : '';

  // Add file access guidance for uploaded attachments
  const fileAccessBlock = `\n\n${FILE_ACCESS_GUIDANCE}`;

  return {
    systemPrompt: [MANAGED_FILES_INTRO, ...sectionBlocks].join('\n\n') + skillsBlock + fileAccessBlock,
    diagnostics: {
      loadedFiles: [...MANAGED_PROMPT_FILE_NAMES],
      includedFiles: includedSections.map((section) => section.fileName),
      emptyFiles: sections.filter((section) => section.content.length === 0).map((section) => section.fileName),
      usedFallback: false,
      fallbackReason: null,
    },
  };
}
