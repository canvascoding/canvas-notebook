import assert from 'node:assert/strict';

import {
  BASE_AGENT_SYSTEM_PROMPT,
  composeManagedAgentSystemPrompt,
} from '../app/lib/agents/system-prompt-shared';
import type { ManagedPromptFiles } from '../app/lib/agents/system-prompt-shared';

function createFiles(overrides: Partial<ManagedPromptFiles> = {}): ManagedPromptFiles {
  return {
    'AGENTS.md': '',
    'IDENTITY.md': '',
    'USER.md': '',
    'MEMORY.md': '',
    'SOUL.md': '',
    'TOOLS.md': '',
    ...overrides,
  };
}

const populated = composeManagedAgentSystemPrompt(
  createFiles({
    'AGENTS.md': '  # AGENTS\n\n- Follow repo rules.\n  ',
    'MEMORY.md': '\nRemember the migration state.\n',
    'SOUL.md': '',
    'TOOLS.md': 'Use filesystem and terminal carefully.\n',
  })
);

assert.equal(populated.diagnostics.usedFallback, false);
assert.deepEqual(populated.diagnostics.includedFiles, ['AGENTS.md', 'MEMORY.md', 'TOOLS.md']);
assert.deepEqual(populated.diagnostics.emptyFiles, ['IDENTITY.md', 'USER.md', 'SOUL.md']);
assert.match(populated.systemPrompt, /^You are an AI assistant in Canvas Notebook\./);
assert.match(populated.systemPrompt, /## AGENTS\.md\n# AGENTS\n\n- Follow repo rules\./);
assert.match(populated.systemPrompt, /## MEMORY\.md\nRemember the migration state\./);
assert.doesNotMatch(populated.systemPrompt, /## SOUL\.md/);
assert.match(populated.systemPrompt, /## TOOLS\.md\nUse filesystem and terminal carefully\./);
assert.match(populated.systemPrompt, /Use the built-in file tools for workspace search/);
assert.match(populated.systemPrompt, /Use `rg` for text\/content search across the workspace/);
assert.match(populated.systemPrompt, /Use `glob` or `bash` with `find` for file\/path discovery/);
assert.doesNotMatch(populated.systemPrompt, /\bqmd\b/);

const fallback = composeManagedAgentSystemPrompt(createFiles());
assert.equal(fallback.systemPrompt, BASE_AGENT_SYSTEM_PROMPT);
assert.equal(fallback.diagnostics.usedFallback, true);
assert.equal(fallback.diagnostics.fallbackReason, 'all-empty');
assert.deepEqual(fallback.diagnostics.emptyFiles, ['AGENTS.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md']);

console.log('Prompt builder test passed');
