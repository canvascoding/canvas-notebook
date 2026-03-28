import { type AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type TSchema } from '@sinclair/typebox';
import { execFile } from 'child_process';
import { constants as fsConstants, promises as fsPromises } from 'fs';
import { promisify } from 'util';
import { getWorkspacePath } from '../utils/workspace-manager';
import { loadSkillsFromDisk, getSkillsDir, AnthropicSkill, type SkillCommand } from './skill-loader';

const execFileAsync = promisify(execFile);
const RESERVED_STATIC_COMMAND_NAMES = new Set(['image-generation', 'video-generation', 'ad-localization', 'qmd']);

// Cache for loaded skills
let cachedSkills: AnthropicSkill[] = [];
let lastLoadTime = 0;
const CACHE_TTL = 5000; // 5 seconds

/**
 * Load skills from disk with caching
 */
async function getCachedSkills(): Promise<AnthropicSkill[]> {
  const now = Date.now();
  if (now - lastLoadTime > CACHE_TTL || cachedSkills.length === 0) {
    cachedSkills = await loadSkillsFromDisk();
    lastLoadTime = now;
  }
  return cachedSkills;
}

/**
 * Check if a skill has executable capabilities
 * Skills with bin/ directory or specific executables are treated as tools
 */
async function hasExecutableCapability(skill: AnthropicSkill): Promise<boolean> {
  for (const command of skill.commands) {
    if (RESERVED_STATIC_COMMAND_NAMES.has(command.name)) {
      continue;
    }

    const skillsDir = getSkillsDir();
    const binPath = `${skillsDir}/bin/${command.name}`;
    try {
      await fsPromises.access(binPath, fsConstants.X_OK);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

function createLegacyPromptParameters() {
  return Type.Object({
    prompt: Type.Optional(Type.String({ description: 'The prompt or input for the skill command' })),
  });
}

function createStructuredParameters(command: SkillCommand) {
  const properties: Record<string, TSchema> = {};

  for (const input of command.inputs) {
    const schema =
      input.type === 'boolean'
        ? Type.Boolean({ description: input.description })
        : Type.String({ description: input.description });

    properties[input.name] = input.required ? schema : Type.Optional(schema);
  }

  return Type.Object(properties);
}

function createToolParameters(command: SkillCommand) {
  switch (command.inputMode) {
    case 'none':
      return Type.Object({});
    case 'structured':
      return createStructuredParameters(command);
    case 'legacy-prompt':
    default:
      return createLegacyPromptParameters();
  }
}

function buildCommandArgs(command: SkillCommand, rawParams: unknown): string[] {
  const params = rawParams && typeof rawParams === 'object' ? rawParams as Record<string, unknown> : {};

  if (command.inputMode === 'none') {
    return [];
  }

  if (command.inputMode === 'legacy-prompt') {
    const prompt = typeof params.prompt === 'string' ? params.prompt : '';
    return prompt ? [prompt] : [];
  }

  const args: string[] = [];

  for (const input of command.inputs) {
    const value = params[input.name];

    if (input.binding.kind === 'flag') {
      if (value === true) {
        args.push(input.binding.flag);
      }
      continue;
    }

    if (typeof value !== 'string' || value.length === 0) {
      if (input.required) {
        throw new Error(`${input.name} is required.`);
      }
      continue;
    }

    args.push(value);
  }

  return args;
}

/**
 * Create PI tools from a skill command manifest.
 */
async function createToolFromCommand(skill: AnthropicSkill, command: SkillCommand): Promise<AgentTool | null> {
  if (RESERVED_STATIC_COMMAND_NAMES.has(command.name)) {
    return null;
  }

  const skillsDir = getSkillsDir();
  const binPath = `${skillsDir}/bin/${command.name}`;
  try {
    await fsPromises.access(binPath, fsConstants.X_OK);
  } catch {
    return null;
  }

  const toolName = command.name.replace(/-/g, '_');
  const toolDescription = command.description || skill.description;

  return {
    name: toolName,
    label: `Using ${command.name}`,
    description: toolDescription,
    parameters: createToolParameters(command),
    execute: async (toolCallId, params) => {
      try {
        const workspacePath = getWorkspacePath();
        const args = buildCommandArgs(command, params);
        const { stdout, stderr } = await execFileAsync(binPath, args, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || stderr || 'Skill executed successfully' }],
          details: { stdout, stderr },
        };
        
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [{ type: 'text', text: `Error executing skill: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

/**
 * Get all dynamic skills as PI tools
 * Only returns skills that have executable capabilities
 */
export async function getDynamicSkillTools(): Promise<AgentTool[]> {
  const skills = await getCachedSkills();
  const tools: AgentTool[] = [];
  
  for (const skill of skills) {
    for (const command of skill.commands) {
      const tool = await createToolFromCommand(skill, command);
      if (tool) {
        tools.push(tool);
      }
    }
  }
  
  return tools;
}

/**
 * Get a specific skill by name
 */
export async function getSkillToolByName(name: string): Promise<AgentTool | null> {
  const skills = await getCachedSkills();
  for (const skill of skills) {
    for (const command of skill.commands) {
      if (command.name === name || command.name.replace(/-/g, '_') === name) {
        return createToolFromCommand(skill, command);
      }
    }
  }
  return null;
}

/**
 * Invalidate the skills cache (call after creating/updating a skill)
 */
export function invalidateSkillsCache(): void {
  cachedSkills = [];
  lastLoadTime = 0;
}

/**
 * Get skill statistics
 */
export async function getDynamicSkillStats(): Promise<{
  total: number;
  executable: number;
  promptBased: number;
}> {
  const skills = await getCachedSkills();
  let executableCount = 0;
  
  for (const skill of skills) {
    if (await hasExecutableCapability(skill)) {
      executableCount++;
    }
  }
  
  return {
    total: skills.length,
    executable: executableCount,
    promptBased: skills.length - executableCount,
  };
}

/**
 * Get all prompt-based skills (non-executable)
 * These are used for system prompt context
 */
export async function getPromptBasedSkills(): Promise<AnthropicSkill[]> {
  const skills = await getCachedSkills();
  const promptSkills: AnthropicSkill[] = [];
  
  for (const skill of skills) {
    const hasExecutable = await hasExecutableCapability(skill);
    if (!hasExecutable) {
      promptSkills.push(skill);
    }
  }
  
  return promptSkills;
}
