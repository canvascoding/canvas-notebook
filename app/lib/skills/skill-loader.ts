import { promises as fs } from 'fs';
import path from 'path';
import { AnthropicSkill, parseSkillFile, getSkillsDir, createDefaultSkillMd } from './skill-manifest-anthropic';

// Re-export types and functions from the new anthropic module
export type { AnthropicSkill } from './skill-manifest-anthropic';
export {
  parseSkillFile,
  getSkillsDir,
  createDefaultSkillMd,
  getSkillsContext,
} from './skill-manifest-anthropic';

/**
 * Load all skills from the skills directory
 * Only supports Anthropic-style SKILL.md format
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
        const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
        
        // Check if SKILL.md exists before trying to parse
        try {
          await fs.access(skillMdPath);
        } catch {
          // SKILL.md doesn't exist - skip this directory silently
          continue;
        }
        
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
          // Log error but don't crash
          console.warn(`[SkillLoader] Error loading skill ${entry.name}:`, error);
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
    const skillContent = createDefaultSkillMd(name, description, content);
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
 * Validate a skill by name
 * Returns validation result with any errors
 */
export async function validateSkillByName(name: string): Promise<{
  valid: boolean;
  errors: string[];
  skill?: AnthropicSkill;
}> {
  try {
    const skill = await loadSkillByName(name);
    
    if (!skill) {
      return { 
        valid: false, 
        errors: [`Skill "${name}" not found or invalid`] 
      };
    }
    
    return { valid: true, errors: [], skill };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { 
      valid: false, 
      errors: [`Failed to validate skill: ${errorMessage}`] 
    };
  }
}

/**
 * Create README.md for a skill (for backward compatibility with existing code)
 * @deprecated Skills now use SKILL.md format
 */
export async function createSkillReadme(
  name: string,
  skill: AnthropicSkill
): Promise<void> {
  const skillsDir = getSkillsDir();
  const readmePath = path.join(skillsDir, name, 'README.md');
  
  const readmeContent = `# ${skill.title}

${skill.description}

## Information

- **Name:** ${skill.name}
- **License:** ${skill.license || 'Not specified'}
- **Compatibility:** ${skill.compatibility || 'Universal'}

## Description

${skill.description}

## Instructions

${skill.content}

---

*This skill uses the Anthropic SKILL.md format.*
`;

  await fs.writeFile(readmePath, readmeContent, 'utf-8');
  console.log(`[SkillLoader] Created README: ${readmePath}`);
}
