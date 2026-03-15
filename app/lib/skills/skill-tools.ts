import { type AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getWorkspacePath } from '../utils/workspace-manager';
import { loadSkillsFromDisk, getSkillsDir, AnthropicSkill } from './skill-loader';

const execAsync = promisify(exec);

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
async function hasExecutableCapability(skillName: string): Promise<boolean> {
  const skillsDir = getSkillsDir();
  const binPath = `${skillsDir}/bin/${skillName}`;
  
  try {
    await execAsync(`test -x ${binPath}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a PI tool from a skill
 * Only creates tools for skills that have executable capabilities
 */
async function createToolFromSkill(skill: AnthropicSkill): Promise<AgentTool | null> {
  // Check if this skill has an executable
  const hasExecutable = await hasExecutableCapability(skill.name);
  
  if (!hasExecutable) {
    // This is a prompt-based skill, not a tool
    return null;
  }
  
  // For executable skills, create a generic tool
  return {
    name: skill.name.replace(/-/g, '_'),
    label: `Using ${skill.title}`,
    description: skill.description,
    parameters: Type.Object({
      prompt: Type.String({ description: 'The prompt or input for the skill' }),
    }),
    execute: async (toolCallId, params) => {
      try {
        const workspacePath = getWorkspacePath();
        const skillsDir = getSkillsDir();
        const { prompt } = params as { prompt: string };
        
        // Execute the skill via the bin wrapper
        const cmd = `${skillsDir}/bin/${skill.name} "${prompt.replace(/"/g, '\\"')}"`;
        
        const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
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
    const tool = await createToolFromSkill(skill);
    if (tool) {
      tools.push(tool);
    }
  }
  
  return tools;
}

/**
 * Get a specific skill by name
 */
export async function getSkillToolByName(name: string): Promise<AgentTool | null> {
  const skills = await getCachedSkills();
  const skill = skills.find(s => s.name === name || s.name.replace(/-/g, '_') === name);
  return skill ? createToolFromSkill(skill) : null;
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
    if (await hasExecutableCapability(skill.name)) {
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
    const hasExecutable = await hasExecutableCapability(skill.name);
    if (!hasExecutable) {
      promptSkills.push(skill);
    }
  }
  
  return promptSkills;
}
