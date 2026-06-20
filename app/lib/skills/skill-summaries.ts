import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';

import {
  loadCanvasSkillInterface,
  parseFrontmatter,
  type CanvasSkillInterface,
  type CanvasSkillStorageScope,
} from './canvas-skill-manifest';
import { loadEnabledPluginSkills } from '@/app/lib/plugins/canvas-plugin-registry';
import { resolveReadableScopedSkillsDataDir } from '@/app/lib/runtime-data-paths';

export type SkillSummary = {
  name: string;
  title: string;
  description: string;
  version?: string;
  enabled: boolean;
  interface?: CanvasSkillInterface;
  plugin?: {
    name: string;
    version: string;
    displayName?: string;
    skillAssetPath?: string;
  };
};

function parseSkillSummary(content: string, fallbackName: string): Omit<SkillSummary, 'enabled'> | null {
  const { frontmatter } = parseFrontmatter(content);
  if (!frontmatter?.name || !frontmatter.description) return null;

  return {
    name: frontmatter.name || fallbackName,
    title: frontmatter.name || fallbackName,
    description: frontmatter.description || '',
    version: frontmatter.metadata?.version,
  };
}

export async function loadSkillSummaries(
  enabledSkills?: string[],
  scope?: CanvasSkillStorageScope | null,
): Promise<SkillSummary[]> {
  const skillsDir = await resolveReadableScopedSkillsDataDir(scope);
  const enabledSet = new Set(enabledSkills || []);
  const allEnabled = !enabledSkills || enabledSkills.length === 0;

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const summaries: Array<SkillSummary | null> = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
        try {
          const content = await fs.readFile(skillMdPath, 'utf-8');
          const summary = parseSkillSummary(content, entry.name);
          if (!summary) return null;
          const skillDir = path.join(skillsDir, entry.name);
          const iface = await loadCanvasSkillInterface(skillDir);
          const skillSummary: SkillSummary = {
            ...summary,
            title: iface?.displayName || summary.title,
            enabled: allEnabled || enabledSet.has(summary.name),
          };
          if (iface) skillSummary.interface = iface;
          return skillSummary;
        } catch {
          return null;
        }
      }));

    const validSummaries: SkillSummary[] = [];
    for (const summary of summaries) {
      if (summary) validSummaries.push(summary);
    }
    const standaloneNames = new Set(validSummaries.map((summary) => summary.name));
    const pluginSkills = await loadEnabledPluginSkills(enabledSkills, scope).catch(() => []);
    for (const skill of pluginSkills) {
      if (standaloneNames.has(skill.name)) {
        continue;
      }
      validSummaries.push({
        name: skill.name,
        title: skill.title,
        description: skill.description,
        version: skill.version,
        enabled: skill.enabled,
        interface: skill.interface,
        plugin: skill.plugin,
      });
    }
    return validSummaries.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function matchesSkillSummaryQuery(skill: SkillSummary, query: string): boolean {
  if (!query) return true;
  const haystack = [skill.name, skill.title, skill.description].join('\n').toLowerCase();
  return haystack.includes(query);
}
