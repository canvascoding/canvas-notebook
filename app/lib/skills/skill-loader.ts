import { promises as fs } from 'fs';
import path from 'path';
import { SkillManifest, validateManifest } from './skill-manifest';

const SKILLS_DIR = '/data/skills';

/**
 * Load all skills from the skills directory
 */
export async function loadSkillsFromDisk(): Promise<SkillManifest[]> {
  const skills: SkillManifest[] = [];
  
  try {
    // Check if skills directory exists
    try {
      await fs.access(SKILLS_DIR);
    } catch {
      console.log(`[SkillLoader] Skills directory not found: ${SKILLS_DIR}`);
      return skills;
    }
    
    // Read all subdirectories in skills folder
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifestPath = path.join(SKILLS_DIR, entry.name, 'manifest.json');
        
        try {
          // Try to read manifest.json
          const manifestContent = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent) as SkillManifest;
          
          // Validate the manifest
          const validation = validateManifest(manifest);
          if (validation.valid) {
            skills.push(manifest);
            console.log(`[SkillLoader] Loaded skill: ${manifest.name}`);
          } else {
            console.warn(`[SkillLoader] Invalid manifest for ${entry.name}:`, validation.errors);
          }
        } catch (error) {
          // Manifest doesn't exist or is invalid - skip this directory
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
export async function loadSkillByName(name: string): Promise<SkillManifest | null> {
  try {
    const manifestPath = path.join(SKILLS_DIR, name, 'manifest.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent) as SkillManifest;
    
    const validation = validateManifest(manifest);
    if (validation.valid) {
      return manifest;
    } else {
      console.warn(`[SkillLoader] Invalid manifest for ${name}:`, validation.errors);
      return null;
    }
  } catch (error) {
    console.warn(`[SkillLoader] Skill not found: ${name}`);
    return null;
  }
}

/**
 * Check if a skill exists
 */
export async function skillExists(name: string): Promise<boolean> {
  try {
    const skillPath = path.join(SKILLS_DIR, name);
    await fs.access(skillPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all skill names
 */
export async function getSkillNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

/**
 * Create a new skill directory with manifest
 */
export async function createSkillDirectory(
  name: string,
  manifest: SkillManifest
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if skill already exists
    if (await skillExists(name)) {
      return { success: false, error: `Skill "${name}" already exists` };
    }
    
    // Create skill directory
    const skillPath = path.join(SKILLS_DIR, name);
    await fs.mkdir(skillPath, { recursive: true });
    
    // Write manifest
    const manifestPath = path.join(skillPath, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    
    console.log(`[SkillLoader] Created skill directory: ${skillPath}`);
    return { success: true };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SkillLoader] Error creating skill ${name}:`, error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Create README.md for a skill
 */
export async function createSkillReadme(
  name: string,
  manifest: SkillManifest
): Promise<void> {
  const readmePath = path.join(SKILLS_DIR, name, 'README.md');
  
  const readmeContent = `# ${manifest.title}

${manifest.description}

## Information

- **Name:** ${manifest.name}
- **Version:** ${manifest.version}
- **Type:** ${manifest.type}
- **Author:** ${manifest.author || 'Unknown'}
- **Created:** ${manifest.created_at}

## Tool

**${manifest.tool.name}**

${manifest.tool.description}

### Parameters

${Object.entries(manifest.tool.parameters)
  .map(([key, param]) => {
    const required = param.required ? ' (required)' : '';
    const type = param.type;
    const desc = param.description;
    const def = param.default !== undefined ? ` Default: ${JSON.stringify(param.default)}` : '';
    const enum_ = param.enum ? ` Options: ${param.enum.join(', ')}` : '';
    return `- **${key}** (${type})${required}: ${desc}${def}${enum_}`;
  })
  .join('\n')}

## Handler

- **Type:** ${manifest.handler.type}
${manifest.handler.command ? `- **Command:** ${manifest.handler.command}` : ''}
${manifest.handler.endpoint ? `- **Endpoint:** ${manifest.handler.endpoint}` : ''}

## Usage

\`\`\`bash
# Using the skill dispatcher
/data/skills/skill ${manifest.name} [options]

# Or directly
${manifest.handler.type === 'cli' ? manifest.handler.command : `curl -X POST ${manifest.handler.endpoint}`}
\`\`\`

---

*This skill was created with the Canvas Notebook Skill Creator.*
`;

  await fs.writeFile(readmePath, readmeContent, 'utf-8');
  console.log(`[SkillLoader] Created README: ${readmePath}`);
}

/**
 * Validate a skill by name
 */
export async function validateSkillByName(name: string): Promise<{
  valid: boolean;
  errors: string[];
  manifest?: SkillManifest;
}> {
  try {
    const manifestPath = path.join(SKILLS_DIR, name, 'manifest.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent) as SkillManifest;
    
    const validation = validateManifest(manifest);
    
    if (validation.valid) {
      return { valid: true, errors: [], manifest };
    } else {
      return { valid: false, errors: validation.errors, manifest };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { 
      valid: false, 
      errors: [`Failed to load skill: ${errorMessage}`] 
    };
  }
}

/**
 * Get skill statistics
 */
export async function getSkillStats(): Promise<{
  total: number;
  cli: number;
  api: number;
  builtIn: number;
  custom: number;
}> {
  const skills = await loadSkillsFromDisk();
  
  return {
    total: skills.length,
    cli: skills.filter(s => s.type === 'cli').length,
    api: skills.filter(s => s.type === 'api').length,
    builtIn: skills.filter(s => !s.author || s.author === 'system').length,
    custom: skills.filter(s => s.author && s.author !== 'system').length,
  };
}
