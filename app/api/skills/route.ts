import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { promises as fs } from 'fs';
import path from 'path';

import { auth } from '@/app/lib/auth';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';

type SkillSummary = {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

const DEFAULT_SUMMARY_LIMIT = 50;
const MAX_SUMMARY_LIMIT = 100;

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

async function loadSkillSummaries(enabledSkills?: string[]): Promise<SkillSummary[]> {
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

function parsePositiveInteger(value: string | null, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const integer = Math.floor(parsed);
  return max ? Math.min(integer, max) : integer;
}

function matchesSkillQuery(skill: SkillSummary, query: string): boolean {
  if (!query) return true;
  const haystack = [skill.name, skill.title, skill.description].join('\n').toLowerCase();
  return haystack.includes(query);
}

function paginate<T>(items: T[], page: number, limit: number): { items: T[]; pagination: Pagination } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * limit;

  return {
    items: items.slice(start, start + limit),
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
    },
  };
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summaryOnly = request.nextUrl.searchParams.get('summary') === '1';
    const config = await readPiRuntimeConfig();
    const skills = summaryOnly
      ? await loadSkillSummaries(config.enabledSkills)
      : await (await import('@/app/lib/skills/skill-loader')).loadSkillsFromDisk(config.enabledSkills);
    const query = request.nextUrl.searchParams.get('query')?.trim().toLowerCase() || '';
    const enabledOnly = request.nextUrl.searchParams.get('enabledOnly') === '1';
    const paginated = summaryOnly && (
      query ||
      enabledOnly ||
      request.nextUrl.searchParams.has('page') ||
      request.nextUrl.searchParams.has('limit')
    );
    const filteredSkills = summaryOnly
      ? (skills as SkillSummary[])
        .filter((skill) => !enabledOnly || skill.enabled)
        .filter((skill) => matchesSkillQuery(skill, query))
      : skills;
    const page = parsePositiveInteger(request.nextUrl.searchParams.get('page'), 1);
    const limit = parsePositiveInteger(request.nextUrl.searchParams.get('limit'), DEFAULT_SUMMARY_LIMIT, MAX_SUMMARY_LIMIT);
    const pageResult = paginated ? paginate(filteredSkills, page, limit) : null;
    const responseSkills = pageResult ? pageResult.items : filteredSkills;
    const stats = {
      total: skills.length,
      enabled: skills.filter((skill) => skill.enabled).length,
      disabled: skills.filter((skill) => !skill.enabled).length,
    };

    return NextResponse.json({
      success: true,
      skills: responseSkills,
      stats,
      ...(pageResult ? { pagination: pageResult.pagination } : {}),
    });
  } catch (error) {
    console.error('[Skills API] Error loading skills:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load skills' },
      { status: 500 }
    );
  }
}
