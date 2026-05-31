import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { loadSkillSummaries, matchesSkillSummaryQuery, type SkillSummary } from '@/app/lib/skills/skill-summaries';
import { paginateItems, parsePositiveInteger } from '@/app/lib/utils/pagination';

const DEFAULT_SUMMARY_LIMIT = 50;
const MAX_SUMMARY_LIMIT = 100;

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
        .filter((skill) => matchesSkillSummaryQuery(skill, query))
      : skills;
    const page = parsePositiveInteger(request.nextUrl.searchParams.get('page'), 1);
    const limit = parsePositiveInteger(request.nextUrl.searchParams.get('limit'), DEFAULT_SUMMARY_LIMIT, MAX_SUMMARY_LIMIT);
    const pageResult = paginated ? paginateItems(filteredSkills, page, limit) : null;
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
