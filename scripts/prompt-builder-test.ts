import assert from 'node:assert/strict';

import {
  composeManagedAgentSystemPrompt,
} from '../app/lib/agents/system-prompt-shared';
import type { ManagedPromptFiles } from '../app/lib/agents/system-prompt-shared';
import type { AnthropicSkill } from '../app/lib/skills/skill-manifest-anthropic';
import { getSkillsContext } from '../app/lib/skills/skill-context';

function createFiles(overrides: Partial<ManagedPromptFiles> = {}): ManagedPromptFiles {
  return {
    'AGENTS.md': '',
    'IDENTITY.md': '',
    'USER.md': '',
    'MEMORY.md': '',
    'SOUL.md': '',
    'TOOLS.md': '',
    'HEARTBEAT.md': '',
    ...overrides,
  };
}

const populated = composeManagedAgentSystemPrompt(
  createFiles({
    'AGENTS.md': '  - Follow repo rules.\n  ',
    'MEMORY.md': '\nRemember the migration state.\n',
    'SOUL.md': '',
    'TOOLS.md': 'Use filesystem and terminal carefully.\n',
  })
);

assert.equal(populated.diagnostics.usedFallback, false);
assert.deepEqual(populated.diagnostics.includedFiles, ['AGENTS.md', 'MEMORY.md', 'TOOLS.md']);
assert.deepEqual(populated.diagnostics.emptyFiles, ['IDENTITY.md', 'USER.md', 'SOUL.md']);
assert.doesNotMatch(populated.systemPrompt, /^You are an AI assistant in Canvas Notebook\./);
assert.match(populated.systemPrompt, /## AGENTS\.md\nSource: .*\/data\/canvas-agent\/AGENTS\.md\n\n- Follow repo rules\./);
assert.match(populated.systemPrompt, /## MEMORY\.md\nSource: .*\/data\/canvas-agent\/MEMORY\.md\n\nRemember the migration state\./);
assert.doesNotMatch(populated.systemPrompt, /## SOUL\.md/);
assert.match(populated.systemPrompt, /## TOOLS\.md\nSource: .*\/data\/canvas-agent\/TOOLS\.md\n\nUse filesystem and terminal carefully\./);
assert.doesNotMatch(populated.systemPrompt, /## File Search Strategy \(CRITICAL\)/);
assert.doesNotMatch(populated.systemPrompt, /## File System Structure/);
assert.doesNotMatch(populated.systemPrompt, /## Temporary Files Directory/);
assert.doesNotMatch(populated.systemPrompt, /## Memory Management \(MEMORY\.md\)/);
assert.match(populated.systemPrompt, /## File Access for Uploaded Attachments/);

const skills: AnthropicSkill[] = [
  {
    name: 'pdf',
    description: 'Use when working with PDF files.',
    title: 'PDF',
    content: 'FULL PDF SKILL BODY SHOULD NOT BE INCLUDED',
    path: '/data/skills/pdf/SKILL.md',
    enabled: true,
    commands: [],
  },
  {
    name: 'disabled-skill',
    description: 'Should not appear.',
    title: 'Disabled Skill',
    content: 'DISABLED SKILL BODY',
    path: '/data/skills/disabled-skill/SKILL.md',
    enabled: false,
    commands: [],
  },
];
const skillsContext = getSkillsContext(skills);
assert.match(skillsContext, /# Enabled Skills/);
assert.match(skillsContext, /## Skill: pdf/);
assert.match(skillsContext, /Description: Use when working with PDF files\./);
assert.match(skillsContext, /Path: \/data\/skills\/pdf\/SKILL\.md/);
assert.doesNotMatch(skillsContext, /FULL PDF SKILL BODY SHOULD NOT BE INCLUDED/);
assert.doesNotMatch(skillsContext, /disabled-skill/);

const fallback = composeManagedAgentSystemPrompt(createFiles());
assert.doesNotMatch(fallback.systemPrompt, /You are an AI assistant in Canvas Notebook/);
assert.match(fallback.systemPrompt, /## File Access for Uploaded Attachments/);
assert.equal(fallback.diagnostics.usedFallback, false);
assert.equal(fallback.diagnostics.fallbackReason, null);
assert.deepEqual(fallback.diagnostics.emptyFiles, ['AGENTS.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md']);

console.log('Prompt builder test passed');
