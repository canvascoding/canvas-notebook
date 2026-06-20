import { promises as fs } from 'fs';
import path from 'path';
import {
  CanvasSkill,
  parseSkillFile,
  getSkillsDir,
  createDefaultSkillMd,
  type CanvasSkillStorageScope,
} from './canvas-skill-manifest';
import { enableSkillInConfig, disableSkillInConfig, areAllSkillsEnabled } from './enabled-skills';
import { resolveReadableScopedSkillsDataDir } from '@/app/lib/runtime-data-paths';
import {
  getAllKnownSkillNames,
  loadEnabledPluginSkills,
} from '@/app/lib/plugins/canvas-plugin-registry';
import { adoptLegacyStandaloneSkillsForScope } from '@/app/lib/skills/legacy-skill-adoption';
import { readEnabledSkillsForScope, writeEnabledSkillsForScope } from './skill-settings';
// Re-export the Canvas skill manifest API for existing call sites.
export type { CanvasSkill, ValidationResult } from './canvas-skill-manifest';
export {
  parseSkillFile,
  getSkillsDir,
  createDefaultSkillMd,
  parseFrontmatter,
  validateFrontmatter,
} from './canvas-skill-manifest';
export { getSkillsContext } from './skill-context';

/**
 * Load all skills from the skills directory
 * Only supports Canvas SKILL.md format
 * Optionally filter by enabled skills list
 */
export async function loadSkillsFromDisk(
  enabledSkills?: string[],
  scope?: CanvasSkillStorageScope | null,
): Promise<CanvasSkill[]> {
  const skills: CanvasSkill[] = [];
  const skillsDir = await resolveReadableScopedSkillsDataDir(scope);
  
  try {
    // Check if skills directory exists
    let hasStandaloneSkillsDir = true;
    try {
      await fs.access(skillsDir);
    } catch {
      hasStandaloneSkillsDir = false;
    }

    if (hasStandaloneSkillsDir) {
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
              if (process.env.DEBUG === 'true') {
                console.log(`[SkillLoader] Loaded skill: ${skill.name} (enabled: ${skill.enabled})`);
              }
            }
          } catch (error) {
            // Log error but don't crash
            console.warn(`[SkillLoader] Error loading skill ${entry.name}:`, error);
          }
        }
      }
    } else if (process.env.DEBUG === 'true') {
      console.log(`[SkillLoader] Skills directory not found: ${skillsDir}`);
    }
  } catch (error) {
    console.error('[SkillLoader] Error loading skills:', error);
  }

  const standaloneSkillNames = new Set(skills.map((skill) => skill.name));
  const pluginSkills = await loadEnabledPluginSkills(enabledSkills, scope).catch((error) => {
    console.warn('[SkillLoader] Error loading plugin skills:', error);
    return [];
  });

  for (const pluginSkill of pluginSkills) {
    if (standaloneSkillNames.has(pluginSkill.name)) {
      console.warn(`[SkillLoader] Skipping plugin skill "${pluginSkill.name}" because a standalone skill with that name exists.`);
      continue;
    }
    skills.push(pluginSkill);
  }

  skills.sort((left, right) => left.name.localeCompare(right.name));

  if (process.env.DEBUG === 'true') {
    console.log(`[SkillLoader] Loaded ${skills.length} skills from disk and plugins`);
  }
  return skills;
}

/**
 * Load a single skill by name
 */
export async function loadSkillByName(
  name: string,
  scope?: CanvasSkillStorageScope | null,
  options: { legacyFallback?: boolean } = {},
): Promise<CanvasSkill | null> {
  const skillsDir = options.legacyFallback === false
    ? getSkillsDir(scope)
    : await resolveReadableScopedSkillsDataDir(scope);
  const skillMdPath = path.join(skillsDir, name, 'SKILL.md');
  try {
    await fs.access(skillMdPath);
    const standaloneSkill = await parseSkillFile(skillMdPath);
    if (standaloneSkill) {
      return standaloneSkill;
    }
  } catch {
    // Fall through to plugin-managed skills.
  }

  const pluginSkills = await loadEnabledPluginSkills(undefined, scope);
  return pluginSkills.find((skill) => skill.name === name) || null;
}

/**
 * Check if a skill exists
 */
export async function skillExists(
  name: string,
  scope?: CanvasSkillStorageScope | null,
  options: { legacyFallback?: boolean } = {},
): Promise<boolean> {
  return Boolean(await loadSkillByName(name, scope, options));
}

/**
 * Get all skill names
 */
export async function getSkillNames(scope?: CanvasSkillStorageScope | null): Promise<string[]> {
  return getAllKnownSkillNames(scope);
}

/**
 * Create a new skill directory with SKILL.md
 */
export async function createSkillDirectory(
  name: string,
  description: string,
  content?: string,
  scope?: CanvasSkillStorageScope | null,
): Promise<{ success: boolean; error?: string; path?: string }> {
  try {
    await adoptLegacyStandaloneSkillsForScope(scope);

    // Check if skill already exists
    if (await skillExists(name, scope, { legacyFallback: false })) {
      return { success: false, error: `Skill "${name}" already exists` };
    }

    // Create skill directory
    const skillsDir = getSkillsDir(scope);
    const skillPath = path.join(skillsDir, name);
    await fs.mkdir(skillPath, { recursive: true });

    // Write SKILL.md
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    const skillContent = createDefaultSkillMd(name, description, content);
    await fs.writeFile(skillMdPath, skillContent, 'utf-8');

    // Auto-enable the new skill in pi-runtime-config
    try {
      const enabledSkills = await readEnabledSkillsForScope(scope);
      if (!areAllSkillsEnabled(enabledSkills)) {
        const allSkillNames = await getSkillNames(scope);
        const nextEnabledSkills = enableSkillInConfig(name, enabledSkills, allSkillNames);
        await writeEnabledSkillsForScope(nextEnabledSkills, { scope });
        console.log(`[SkillLoader] Auto-enabled skill "${name}" in config`);
      }
    } catch (cfgError) {
      console.warn(`[SkillLoader] Could not auto-enable skill "${name}" in config:`, cfgError);
    }

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
export async function getSkillStats(scope?: CanvasSkillStorageScope | null): Promise<{
  total: number;
  enabled: number;
  disabled: number;
}> {
  const skills = await loadSkillsFromDisk(undefined, scope);
  
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
export async function validateSkillByName(name: string, scope?: CanvasSkillStorageScope | null): Promise<{
  valid: boolean;
  errors: string[];
  skill?: CanvasSkill;
}> {
  try {
    const skill = await loadSkillByName(name, scope);
    
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
  skill: CanvasSkill,
  scope?: CanvasSkillStorageScope | null,
): Promise<void> {
  const skillsDir = getSkillsDir(scope);
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

*This skill uses the Canvas SKILL.md format.*
`;

  await fs.writeFile(readmePath, readmeContent, 'utf-8');
  console.log(`[SkillLoader] Created README: ${readmePath}`);
}

export async function deleteSkillDirectory(
  name: string,
  scope?: CanvasSkillStorageScope | null,
): Promise<{ success: boolean; error?: string }> {
  try {
    await adoptLegacyStandaloneSkillsForScope(scope);

    const skillsDir = getSkillsDir(scope);
    const skillPath = path.join(skillsDir, name);
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    const hasStandaloneSkill = await fs.access(skillMdPath).then(() => true).catch(() => false);

    if (!hasStandaloneSkill) {
      if (await skillExists(name, scope, { legacyFallback: false })) {
        return { success: false, error: `Skill "${name}" is managed by a plugin. Disable or remove the plugin instead.` };
      }
      return { success: false, error: `Skill "${name}" not found` };
    }

    const resolvedSkillPath = path.resolve(/*turbopackIgnore: true*/ skillPath);
    const resolvedSkillsDir = path.resolve(/*turbopackIgnore: true*/ skillsDir);
    if (!resolvedSkillPath.startsWith(`${resolvedSkillsDir}${path.sep}`)) {
      return { success: false, error: 'Invalid skill name: path traversal detected' };
    }

    await fs.rm(skillPath, { recursive: true, force: true });

    try {
      const enabledSkills = await readEnabledSkillsForScope(scope);
      const allSkillNames = await getSkillNames(scope);
      const nextEnabledSkills = disableSkillInConfig(name, enabledSkills, allSkillNames);
      await writeEnabledSkillsForScope(nextEnabledSkills, { scope });
      console.log(`[SkillLoader] Removed skill "${name}" from enabled-skills config`);
    } catch (cfgError) {
      console.warn(`[SkillLoader] Could not remove skill "${name}" from config:`, cfgError);
    }

    console.log(`[SkillLoader] Deleted skill: ${skillPath}`);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SkillLoader] Error deleting skill ${name}:`, error);
    return { success: false, error: errorMessage };
  }
}
