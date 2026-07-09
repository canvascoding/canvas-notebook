import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';

import { requirePathInside } from '@/app/lib/security/safe-paths';
import { CORE_SKILL_NAMES, isCoreSkillName } from '@/app/lib/skills/core-skills';
import {
  parseSkillFile,
  type CanvasSkill,
} from '@/app/lib/skills/canvas-skill-manifest';

export const CORE_SKILLS_DIR = path.join(process.cwd(), 'seed_skills');

export function resolveCoreSkillDir(skillName: string): string | null {
  if (!isCoreSkillName(skillName)) {
    return null;
  }
  return requirePathInside(CORE_SKILLS_DIR, skillName);
}

export function resolveCoreSkillPath(skillName: string): string | null {
  const skillDir = resolveCoreSkillDir(skillName);
  return skillDir ? requirePathInside(skillDir, 'SKILL.md') : null;
}

function markCoreSkill(skill: CanvasSkill): CanvasSkill {
  return {
    ...skill,
    enabled: true,
    isCustom: false,
    core: true,
  };
}

export async function loadCoreSkillByName(skillName: string): Promise<CanvasSkill | null> {
  const skillPath = resolveCoreSkillPath(skillName);
  if (!skillPath) {
    return null;
  }

  const stat = await fs.stat(skillPath).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }

  const skill = await parseSkillFile(skillPath);
  return skill ? markCoreSkill(skill) : null;
}

export async function loadCoreSkills(): Promise<CanvasSkill[]> {
  const skills = await Promise.all(CORE_SKILL_NAMES.map((skillName) => loadCoreSkillByName(skillName)));
  return skills
    .filter((skill): skill is CanvasSkill => Boolean(skill))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function resolveCoreSkillFilePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const [skillName, ...parts] = normalized.split('/').filter(Boolean);
  if (!skillName || !isCoreSkillName(skillName) || parts.length === 0) {
    return null;
  }

  const skillDir = resolveCoreSkillDir(skillName);
  return skillDir ? requirePathInside(skillDir, ...parts) : null;
}
