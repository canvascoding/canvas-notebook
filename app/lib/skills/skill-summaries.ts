import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';

import {
  getSkillsDir,
  loadCanvasSkillInterface,
  parseFrontmatter,
  type CanvasSkillInterface,
} from './canvas-skill-manifest';

export type SkillSummary = {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  interface?: CanvasSkillInterface;
};

function parseSkillSummary(content: string, fallbackName: string): Omit<SkillSummary, 'enabled'> | null {
  const { frontmatter } = parseFrontmatter(content);
  if (!frontmatter?.name || !frontmatter.description) return null;

  return {
    name: frontmatter.name || fallbackName,
    title: frontmatter.name || fallbackName,
    description: frontmatter.description || '',
  };
}

export async function loadSkillSummaries(enabledSkills?: string[]): Promise<SkillSummary[]> {
  const skillsDir = getSkillsDir();
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
