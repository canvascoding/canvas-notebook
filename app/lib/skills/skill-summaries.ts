import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';

export type SkillSummary = {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
};

function getSkillsDir(): string {
  return path.join(process.env.DATA || '/data', 'skills');
}

function parseSkillSummary(content: string, fallbackName: string): Omit<SkillSummary, 'enabled'> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  let name = fallbackName;
  let description = '';

  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    const colonIndex = line.indexOf(':');
    if (colonIndex <= 0) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key === 'name' && value) {
      name = value;
    } else if (key === 'description') {
      description = value;
    }
  }

  return {
    name,
    title: name,
    description,
  };
}

export async function loadSkillSummaries(enabledSkills?: string[]): Promise<SkillSummary[]> {
  const skillsDir = getSkillsDir();
  const enabledSet = new Set(enabledSkills || []);
  const allEnabled = !enabledSkills || enabledSkills.length === 0;

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const summaries = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
        try {
          const content = await fs.readFile(skillMdPath, 'utf-8');
          const summary = parseSkillSummary(content, entry.name);
          if (!summary) return null;
          return {
            ...summary,
            enabled: allEnabled || enabledSet.has(summary.name),
          };
        } catch {
          return null;
        }
      }));

    return summaries
      .filter((summary): summary is SkillSummary => Boolean(summary))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function matchesSkillSummaryQuery(skill: SkillSummary, query: string): boolean {
  if (!query) return true;
  const haystack = [skill.name, skill.title, skill.description].join('\n').toLowerCase();
  return haystack.includes(query);
}
