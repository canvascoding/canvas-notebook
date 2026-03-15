import { type AgentTool } from '@mariozechner/pi-agent-core';
import { Type, TSchema } from '@sinclair/typebox';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getWorkspacePath } from '../utils/workspace-manager';
import { SkillManifest, manifestParamsToTypeBox } from './skill-manifest';
import { loadSkillsFromDisk } from './skill-loader';

const execAsync = promisify(exec);

// Cache for loaded skills
let cachedSkills: SkillManifest[] = [];
let lastLoadTime = 0;
const CACHE_TTL = 5000; // 5 seconds

/**
 * Load skills from disk with caching
 */
async function getCachedSkills(): Promise<SkillManifest[]> {
  const now = Date.now();
  if (now - lastLoadTime > CACHE_TTL || cachedSkills.length === 0) {
    cachedSkills = await loadSkillsFromDisk();
    lastLoadTime = now;
  }
  return cachedSkills;
}

/**
 * Create a PI tool from a skill manifest
 */
function createToolFromManifest(manifest: SkillManifest): AgentTool {
  // Convert manifest parameters to TypeBox schema
  const typeboxParams = manifestParamsToTypeBox(manifest.tool.parameters);
  
  return {
    name: manifest.tool.name,
    label: `Using ${manifest.title}`,
    description: manifest.tool.description,
    parameters: Type.Object(typeboxParams),
    execute: async (toolCallId, params) => {
      try {
        const workspacePath = getWorkspacePath();
        const typedParams = params as Record<string, unknown>;
        
        if (manifest.handler.type === 'cli') {
          // Build CLI command
          let cmd = manifest.handler.command || `/data/skills/${manifest.name}/run`;
          
          // Add parameters as arguments
          for (const [key, value] of Object.entries(typedParams)) {
            if (value !== undefined && value !== null) {
              const paramDef = manifest.tool.parameters[key];
              
              if (paramDef?.type === 'boolean' && value === true) {
                cmd += ` --${key}`;
              } else {
                const stringValue = String(value).replace(/"/g, '\\"');
                cmd += ` --${key} "${stringValue}"`;
              }
            }
          }
          
          const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
          return {
            content: [{ type: 'text', text: stdout || stderr || 'Command executed' }],
            details: { stdout, stderr },
          };
          
        } else if (manifest.handler.type === 'api') {
          // For API skills, we would call the endpoint
          // This is a placeholder - actual implementation would depend on the API structure
          return {
            content: [{ type: 'text', text: `API skill "${manifest.name}" called with parameters: ${JSON.stringify(params)}` }],
            details: { params },
          };
        }
        
        return {
          content: [{ type: 'text', text: `Unknown handler type for skill "${manifest.name}"` }],
          details: { error: 'Unknown handler type' },
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
 */
export async function getDynamicSkillTools(): Promise<AgentTool[]> {
  const skills = await getCachedSkills();
  return skills.map(createToolFromManifest);
}

/**
 * Get a specific skill by name
 */
export async function getSkillToolByName(name: string): Promise<AgentTool | null> {
  const skills = await getCachedSkills();
  const skill = skills.find(s => s.name === name || s.tool.name === name);
  return skill ? createToolFromManifest(skill) : null;
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
  cli: number;
  api: number;
}> {
  const skills = await getCachedSkills();
  return {
    total: skills.length,
    cli: skills.filter(s => s.type === 'cli').length,
    api: skills.filter(s => s.type === 'api').length,
  };
}
