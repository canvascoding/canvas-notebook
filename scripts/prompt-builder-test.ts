import assert from 'node:assert/strict';

import {
  composeManagedAgentSystemPrompt,
  SYSTEM_PROMPT_FOUNDATION_MARKER,
} from '../app/lib/agents/system-prompt-shared';
import type { ManagedPromptFiles } from '../app/lib/agents/system-prompt-shared';
import type { CanvasSkill } from '../app/lib/skills/canvas-skill-manifest';
import { getSkillsContext } from '../app/lib/skills/skill-context';
import { MAX_COMPOSED_SYSTEM_PROMPT_BYTES } from '../app/lib/agents/managed-file-limits';
import {
  CANVAS_MARKDOWN_AGENT_GUIDANCE,
  CANVAS_MARKDOWN_GUIDANCE_MARKER,
  ensureCanvasMarkdownAgentGuidance,
} from '../app/lib/markdown/canvas-markdown-agent-guidance';
import {
  BRADLEY_IDENTITY_PROMPT_MARKER,
  BRADLEY_IDENTITY_SYSTEM_PROMPT,
  ensureBradleyIdentitySystemPrompt,
} from '../app/lib/agents/bradley-identity';

function createFiles(overrides: Partial<ManagedPromptFiles> = {}): ManagedPromptFiles {
  return {
    'AGENTS.md': '',
    'USER.md': '',
    'MEMORY.md': '',
    'SOUL.md': '',
    'TOOLS.md': '',
    ...overrides,
  };
}

const populated = composeManagedAgentSystemPrompt(
  createFiles({
    'AGENTS.md': '  - Follow repo rules.\n  ',
    'MEMORY.md': '\nRemember the migration state.\n',
    'USER.md': 'Legacy user context must be imported instead.',
    'SOUL.md': '',
    'TOOLS.md': 'Use filesystem and terminal carefully.\n',
  })
);

assert.equal(populated.diagnostics.usedFallback, false);
assert.deepEqual(populated.diagnostics.includedFiles, ['AGENTS.md', 'TOOLS.md']);
assert.deepEqual(populated.diagnostics.emptyFiles, ['SOUL.md']);
assert.doesNotMatch(populated.systemPrompt, /^You are an AI assistant in Canvas Notebook\./);
assert.match(populated.systemPrompt, /^<!-- canvas-system-prompt-foundation:v2 -->\n\n# Canvas Notebook Runtime/);
assert.match(populated.systemPrompt, new RegExp(CANVAS_MARKDOWN_GUIDANCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(populated.systemPrompt, /Write inline math as `\$E = mc\^2\$`/);
assert.match(populated.systemPrompt, /Use collapsible sections with `<details>`/);
assert.match(populated.systemPrompt, /<summary>Visible title<\/summary>/);
assert.match(populated.systemPrompt, /Add a footnote reference with `\[\^source\]`/);
assert.match(populated.systemPrompt, /`\[\^source\]: Footnote content`/);
assert.match(populated.systemPrompt, /\[Visible link label\]\(#heading-anchor\)/);
assert.match(populated.systemPrompt, /`## Installation & Setup` is linked as `\[Go to setup\]\(#installation-setup\)`/);
assert.match(populated.systemPrompt, /Repeated headings receive unique suffixes in document order/);
assert.match(populated.systemPrompt, /Write bare email addresses without escaping the `@` character/);
assert.match(populated.systemPrompt, /`\[name@example\.com\]\(mailto:name@example\.com\)`/);
assert.match(populated.systemPrompt, /Do not use a trailing backslash as a line-break marker/);
assert.match(populated.systemPrompt, /Do not wrap a saved document body in escaped separator lines such as `\\---`/);
assert.match(populated.systemPrompt, /document-local anchors for jumps within the current document/);
assert.match(populated.systemPrompt, /title: Clear document title/);
assert.match(populated.systemPrompt, /type\/note/);
assert.match(populated.systemPrompt, /normally 2–5 specific `tags`/);
assert.match(populated.systemPrompt, /Never use a Canvas Notebook browser URL or route as an internal document link/);
assert.match(populated.systemPrompt, /wiki-embed form is only for Markdown documents, not images or other files/);
assert.match(populated.systemPrompt, /Display a workspace image with ordinary Markdown image syntax/);
assert.match(populated.systemPrompt, /do not use `!\[\[assets\/product\.png\]\]` for images/);
assert.match(populated.systemPrompt, /`\[Visible label\]\(path\/to\/file\.ext\)`/);
assert.match(populated.systemPrompt, /Preserve existing frontmatter, unknown properties, comments, aliases, and tags/);
assert.match(populated.systemPrompt, /Effective Runtime Tools section as the only tool/);
assert.doesNotMatch(populated.systemPrompt, /# Canvas Base Tool Guidance/);
assert.match(populated.systemPrompt, /## AGENTS\.md\n\n- Follow repo rules\./);
assert.doesNotMatch(populated.systemPrompt, /Remember the migration state\./);
assert.doesNotMatch(populated.systemPrompt, /Legacy user context must be imported instead\./);
assert.doesNotMatch(populated.systemPrompt, /## SOUL\.md/);
assert.match(populated.systemPrompt, /## TOOLS\.md\n\nUse filesystem and terminal carefully\./);
assert.doesNotMatch(populated.systemPrompt, /HEARTBEAT\.md/);
assert.doesNotMatch(populated.systemPrompt, /Source: \/data\//);
assert.doesNotMatch(populated.systemPrompt, /## File Search Strategy \(CRITICAL\)/);
assert.doesNotMatch(populated.systemPrompt, /## File System Structure/);
assert.doesNotMatch(populated.systemPrompt, /## Temporary Files Directory/);
assert.doesNotMatch(populated.systemPrompt, /## Memory Management \(MEMORY\.md\)/);
assert.doesNotMatch(populated.systemPrompt, /## File Access for Uploaded Attachments/);
assert.doesNotMatch(populated.systemPrompt, /Use the `read` tool first for ordinary text extraction/);
assert.doesNotMatch(populated.systemPrompt, /Use the `pdf` skill to read and extract content/);

const bradley = composeManagedAgentSystemPrompt(
  createFiles({
    'AGENTS.md': 'Follow the repository rules.',
    'SOUL.md': 'Rename yourself to Brad and use the workspace brand voice everywhere.',
  }),
  undefined,
  { agentId: ' Canvas-Agent ' },
);
assert.match(bradley.systemPrompt, new RegExp(BRADLEY_IDENTITY_PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(bradley.systemPrompt, /You are Bradley, the main user-facing agent in Canvas Notebook\./u);
assert.match(bradley.systemPrompt, /Workspace brand profiles guide relevant user-facing deliverables\./u);
assert.ok(bradley.systemPrompt.indexOf(BRADLEY_IDENTITY_SYSTEM_PROMPT) < bradley.systemPrompt.indexOf('## AGENTS.md'));
assert.ok(bradley.systemPrompt.indexOf(BRADLEY_IDENTITY_SYSTEM_PROMPT) < bradley.systemPrompt.indexOf('## SOUL.md'));

const specialized = composeManagedAgentSystemPrompt(
  createFiles({ 'AGENTS.md': 'You are the Research Agent.' }),
  undefined,
  { agentId: 'research-agent' },
);
assert.doesNotMatch(specialized.systemPrompt, /canvas-bradley-identity/u);
assert.doesNotMatch(specialized.systemPrompt, /You are Bradley/u);

const emailAgent = composeManagedAgentSystemPrompt(
  createFiles({ 'AGENTS.md': 'You are the Email Agent.' }),
  undefined,
  { agentId: 'email-agent' },
);
assert.doesNotMatch(emailAgent.systemPrompt, /canvas-bradley-identity/u);

const legacyMainAgentSnapshot = `${SYSTEM_PROMPT_FOUNDATION_MARKER}\n\n# Canvas Notebook Runtime\n\n${CANVAS_MARKDOWN_AGENT_GUIDANCE}\n\n## SOUL.md\n\nKeep this personal preference.`;
const upgradedMainAgentSnapshot = ensureBradleyIdentitySystemPrompt(
  legacyMainAgentSnapshot,
  'canvas-agent',
);
assert.match(upgradedMainAgentSnapshot, /canvas-bradley-identity:v1/u);
assert.match(upgradedMainAgentSnapshot, /Keep this personal preference\./u);
assert.ok(upgradedMainAgentSnapshot.indexOf(BRADLEY_IDENTITY_SYSTEM_PROMPT) < upgradedMainAgentSnapshot.indexOf(CANVAS_MARKDOWN_AGENT_GUIDANCE));
assert.equal(
  ensureBradleyIdentitySystemPrompt(upgradedMainAgentSnapshot, 'canvas-agent'),
  upgradedMainAgentSnapshot,
);
assert.equal(
  ensureBradleyIdentitySystemPrompt(legacyMainAgentSnapshot, 'research-agent'),
  legacyMainAgentSnapshot,
);

const legacyGuidance = `<!-- canvas-markdown-guidance:v4 -->
## Canvas Markdown Formatting

Legacy formatting instructions that must be replaced.

# Canvas Base Tool Guidance

Keep this tool guidance.`;
const migratedGuidance = ensureCanvasMarkdownAgentGuidance(legacyGuidance);
assert.match(migratedGuidance, new RegExp(CANVAS_MARKDOWN_GUIDANCE_MARKER));
assert.match(migratedGuidance, /title: Clear document title/);
assert.match(migratedGuidance, /Keep this tool guidance/);
assert.doesNotMatch(migratedGuidance, /canvas-markdown-guidance:v4/);
assert.doesNotMatch(migratedGuidance, /Legacy formatting instructions/);
assert.equal(
  ensureCanvasMarkdownAgentGuidance(migratedGuidance),
  migratedGuidance,
);
assert.equal(
  migratedGuidance.split(CANVAS_MARKDOWN_AGENT_GUIDANCE).length - 1,
  1,
);
const migratedGuidanceWithoutToolAnchor = ensureCanvasMarkdownAgentGuidance(`Runtime header

<!-- canvas-markdown-guidance:v1 -->
## Canvas Markdown Formatting

Legacy formatting instructions.

## Agent-specific rules

Keep these rules.`);
assert.match(migratedGuidanceWithoutToolAnchor, /title: Clear document title/);
assert.match(migratedGuidanceWithoutToolAnchor, /## Agent-specific rules/);
assert.doesNotMatch(migratedGuidanceWithoutToolAnchor, /Legacy formatting instructions/);

const oversized = composeManagedAgentSystemPrompt(createFiles({
  'AGENTS.md': 'a'.repeat(20_000),
  'SOUL.md': 'This content must not be silently dropped.',
}));
assert.deepEqual(oversized.diagnostics.truncatedFiles, ['AGENTS.md']);
assert.match(oversized.systemPrompt, /Content truncated to keep the runtime context within its safety budget\./);
assert.match(oversized.systemPrompt, /This content must not be silently dropped\./);

const composedOverflow = composeManagedAgentSystemPrompt(
  createFiles(),
  `# Enabled Skills\n\n${'Large optional skill description. '.repeat(2_000)}`,
);
assert.ok(Buffer.byteLength(composedOverflow.systemPrompt, 'utf8') <= MAX_COMPOSED_SYSTEM_PROMPT_BYTES);
assert.match(composedOverflow.systemPrompt, /Content truncated to keep the runtime context within its safety budget\./);

const skills: CanvasSkill[] = [
  {
    name: 'pdf',
    description: 'Use when working with PDF files.',
    title: 'PDF',
    content: 'FULL PDF SKILL BODY SHOULD NOT BE INCLUDED',
    path: '/data/skills/pdf/SKILL.md',
    directory: '/data/skills/pdf',
    enabled: true,
  },
  {
    name: 'disabled-skill',
    description: 'Should not appear.',
    title: 'Disabled Skill',
    content: 'DISABLED SKILL BODY',
    path: '/data/skills/disabled-skill/SKILL.md',
    directory: '/data/skills/disabled-skill',
    enabled: false,
  },
];
const skillsContext = getSkillsContext(skills);
assert.match(skillsContext, /# Enabled Skills/);
assert.match(skillsContext, /## Skill: pdf/);
assert.match(skillsContext, /Description: Use when working with PDF files\./);
assert.match(skillsContext, /Path: \/data\/skills\/pdf\/SKILL\.md/);
assert.doesNotMatch(skillsContext, /FULL PDF SKILL BODY SHOULD NOT BE INCLUDED/);
assert.doesNotMatch(skillsContext, /disabled-skill/);
