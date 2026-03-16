/**
 * Anthropic Skill Manifest Schema and Parser
 * 
 * Defines the structure for Anthropic-style SKILL.md files.
 * Each skill is defined by a SKILL.md file in /data/skills/<skill-name>/
 * 
 * Format:
 * ---
 * name: skill-name
 * description: When to use this skill...
 * license: Optional license info
 * ---
 * 
 * # Skill Title
 * 
 * Markdown content with instructions...
 */

import { promises as fs } from 'fs';
import path from 'path';

// Skill metadata from YAML frontmatter
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
}

// Complete skill definition
export interface AnthropicSkill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  title: string;
  content: string; // Full markdown content after frontmatter
  path: string; // Full path to SKILL.md
  enabled: boolean; // Whether skill is enabled
}

// Validation result
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Parse YAML frontmatter from markdown content
 * Returns the parsed frontmatter and the remaining content
 */
export function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter | null;
  body: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: null, body: content };
  }

  const yamlContent = match[1];
  const body = match[2].trim();

  // Simple YAML parser for basic key-value pairs
  const frontmatter: Partial<SkillFrontmatter> = {};
  const lines = yamlContent.split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      let value = line.substring(colonIndex + 1).trim();
      
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      if (key === 'name') frontmatter.name = value;
      if (key === 'description') frontmatter.description = value;
      if (key === 'license') frontmatter.license = value;
      if (key === 'compatibility') frontmatter.compatibility = value;
    }
  }

  return { 
    frontmatter: frontmatter as SkillFrontmatter, 
    body 
  };
}

/**
 * Extract title from markdown body (first # heading)
 * Falls back to skill name if no heading found
 */
export function extractTitle(body: string, skillName: string): string {
  const titleMatch = body.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    return titleMatch[1].trim();
  }
  // Fallback: convert kebab-case name to title case
  return skillName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Validate a skill frontmatter
 */
export function validateFrontmatter(frontmatter: SkillFrontmatter | null): ValidationResult {
  const errors: string[] = [];

  if (!frontmatter) {
    errors.push('Missing YAML frontmatter');
    return { valid: false, errors };
  }

  if (!frontmatter.name) {
    errors.push('Missing required field: name');
  } else if (!/^[a-z][a-z0-9-]*$/.test(frontmatter.name)) {
    errors.push('name: Must be kebab-case (lowercase letters, numbers, hyphens), starting with a letter');
  }

  if (!frontmatter.description) {
    errors.push('Missing required field: description');
  } else if (frontmatter.description.length < 10) {
    errors.push('description: Must be at least 10 characters');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Parse a SKILL.md file into an AnthropicSkill object
 */
export async function parseSkillFile(skillPath: string): Promise<AnthropicSkill | null> {
  try {
    const content = await fs.readFile(skillPath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    
    const validation = validateFrontmatter(frontmatter);
    if (!validation.valid) {
      console.warn(`[SkillParser] Invalid skill at ${skillPath}:`, validation.errors);
      return null;
    }

    const skillName = frontmatter!.name;
    const title = extractTitle(body, skillName);

    return {
      name: skillName,
      description: frontmatter!.description,
      license: frontmatter!.license,
      compatibility: frontmatter!.compatibility,
      title,
      content: body,
      path: skillPath,
      enabled: true, // Default to enabled
    };
  } catch (error) {
    console.error(`[SkillParser] Error parsing skill at ${skillPath}:`, error);
    return null;
  }
}

/**
 * Create a default SKILL.md content for a new skill
 */
export function createDefaultSkillMd(
  name: string,
  description: string,
  title: string,
  content: string = ''
): string {
  return `---
name: ${name}
description: "${description}"
---

# ${title}

${content || 'Add your skill instructions here...'}
`;
}

/**
 * Get skill directory path
 */
export function getSkillsDir(): string {
  const DATA = process.env.DATA || '/data';
  return path.join(DATA, 'skills');
}

/**
 * Load all skills from the skills directory
 * Optionally filter by enabled skills list
 */
export async function loadSkillsFromDisk(enabledSkills?: string[]): Promise<AnthropicSkill[]> {
  const skills: AnthropicSkill[] = [];
  const skillsDir = getSkillsDir();
  
  try {
    // Check if skills directory exists
    try {
      await fs.access(skillsDir);
    } catch {
      console.log(`[SkillLoader] Skills directory not found: ${skillsDir}`);
      return skills;
    }
    
    // Read all subdirectories in skills folder
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Skip non-skill directories like 'bin'
        if (entry.name === 'bin') {
          continue;
        }
        
        const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
        
        try {
          // Try to parse SKILL.md
          const skill = await parseSkillFile(skillMdPath);
          if (skill) {
            // Check if skill is enabled
            // If enabledSkills is empty or not provided, all skills are enabled
            // If enabledSkills is provided and not empty, only those skills are enabled
            if (!enabledSkills || enabledSkills.length === 0) {
              skill.enabled = true;
            } else {
              skill.enabled = enabledSkills.includes(skill.name);
            }
            
            skills.push(skill);
            console.log(`[SkillLoader] Loaded skill: ${skill.name} (enabled: ${skill.enabled})`);
          }
        } catch (error) {
          // SKILL.md doesn't exist or is invalid - skip this directory
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`[SkillLoader] Error loading skill ${entry.name}:`, error);
          }
        }
      }
    }
    
    console.log(`[SkillLoader] Loaded ${skills.length} skills from disk`);
    return skills;
    
  } catch (error) {
    console.error('[SkillLoader] Error loading skills:', error);
    return skills;
  }
}

/**
 * Load a single skill by name
 */
export async function loadSkillByName(name: string): Promise<AnthropicSkill | null> {
  const skillsDir = getSkillsDir();
  const skillMdPath = path.join(skillsDir, name, 'SKILL.md');
  return parseSkillFile(skillMdPath);
}

/**
 * Check if a skill exists
 */
export async function skillExists(name: string): Promise<boolean> {
  const skillsDir = getSkillsDir();
  const skillMdPath = path.join(skillsDir, name, 'SKILL.md');
  try {
    await fs.access(skillMdPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all skill names
 */
export async function getSkillNames(): Promise<string[]> {
  const skillsDir = getSkillsDir();
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const names: string[] = [];
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
        try {
          await fs.access(skillMdPath);
          names.push(entry.name);
        } catch {
          // No SKILL.md, skip
        }
      }
    }
    
    return names;
  } catch {
    return [];
  }
}

/**
 * Create a new skill directory with SKILL.md
 */
export async function createSkillDirectory(
  name: string,
  description: string,
  title: string,
  content?: string
): Promise<{ success: boolean; error?: string; path?: string }> {
  try {
    // Check if skill already exists
    if (await skillExists(name)) {
      return { success: false, error: `Skill "${name}" already exists` };
    }
    
    // Create skill directory
    const skillsDir = getSkillsDir();
    const skillPath = path.join(skillsDir, name);
    await fs.mkdir(skillPath, { recursive: true });
    
    // Write SKILL.md
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    const skillContent = createDefaultSkillMd(name, description, title, content);
    await fs.writeFile(skillMdPath, skillContent, 'utf-8');
    
    console.log(`[SkillLoader] Created skill: ${skillPath}`);
    return { success: true, path: skillPath };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SkillLoader] Error creating skill ${name}:`, error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Get skill statistics
 */
export async function getSkillStats(): Promise<{
  total: number;
  enabled: number;
  disabled: number;
}> {
  const skills = await loadSkillsFromDisk();
  
  return {
    total: skills.length,
    enabled: skills.filter(s => s.enabled).length,
    disabled: skills.filter(s => !s.enabled).length,
  };
}

/**
 * Format skills for PI Agent system prompt
 * Returns a formatted string with all enabled skills
 */
export function formatSkillsForPrompt(skills: AnthropicSkill[]): string {
  if (skills.length === 0) {
    return '';
  }

  const enabledSkills = skills.filter(s => s.enabled);
  
  if (enabledSkills.length === 0) {
    return '';
  }

  let prompt = '\n\n## Available Skills\n\n';
  prompt += 'You have access to the following skills. Use them when appropriate based on their descriptions:\n\n';

  for (const skill of enabledSkills) {
    prompt += `### ${skill.name}\n`;
    prompt += `${skill.description}\n\n`;
  }

  return prompt;
}

/**
 * Get full skill content for PI Agent context
 * Returns the full markdown content of enabled skills
 */
export function getSkillsContext(skills: AnthropicSkill[]): string {
  const enabledSkills = skills.filter(s => s.enabled);
  
  if (enabledSkills.length === 0) {
    return '';
  }

  let context = '\n\n# Skill Instructions\n\n';
  context += 'When the user requests tasks that match the following skill descriptions, ';
  context += 'follow the detailed instructions provided for each skill.\n\n';

  for (const skill of enabledSkills) {
    context += `---\n\n`;
    context += `## Skill: ${skill.name}\n\n`;
    context += `**Description:** ${skill.description}\n\n`;
    context += `${skill.content}\n\n`;
  }

  return context;
}
