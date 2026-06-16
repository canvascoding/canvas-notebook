'use client';

import { useEffect, useMemo, useState } from 'react';

import { CanvasSkillIcon } from '@/app/lib/skills/skill-icons';
import type { CanvasSkillInterface } from '@/app/lib/skills/canvas-skill-manifest';
import { cn } from '@/lib/utils';

export type SkillReferenceChipSkill = {
  name: string;
  title: string;
  description: string;
  enabled?: boolean;
  interface?: CanvasSkillInterface;
  plugin?: {
    name: string;
    skillAssetPath?: string;
  };
};

type SkillApiResponse = {
  success: boolean;
  skills?: SkillReferenceChipSkill[];
};

let cachedSkills: SkillReferenceChipSkill[] | null = null;
let pendingSkillsRequest: Promise<SkillReferenceChipSkill[]> | null = null;

const SKILL_REFERENCE_PATTERN = /(^|[\s([{"'`,;])\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s)\]}",.;:!?])/g;

async function loadSkillReferences(): Promise<SkillReferenceChipSkill[]> {
  if (cachedSkills) {
    return cachedSkills;
  }

  pendingSkillsRequest ??= fetch('/api/skills')
    .then(async (response) => {
      if (!response.ok) return [];
      const data = (await response.json()) as SkillApiResponse;
      const skills = (data.success && Array.isArray(data.skills) ? data.skills : [])
        .filter((skill) => skill.enabled !== false);
      cachedSkills = skills;
      return skills;
    })
    .catch(() => [])
    .finally(() => {
      pendingSkillsRequest = null;
    });

  return pendingSkillsRequest;
}

export function useSkillReferenceCatalog(): Map<string, SkillReferenceChipSkill> {
  const [skills, setSkills] = useState<SkillReferenceChipSkill[]>(cachedSkills || []);

  useEffect(() => {
    let cancelled = false;
    void loadSkillReferences().then((nextSkills) => {
      if (!cancelled) {
        setSkills(nextSkills);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    return new Map(skills.map((skill) => [skill.name, skill]));
  }, [skills]);
}

export function extractSkillReferenceNames(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(SKILL_REFERENCE_PATTERN)) {
    const name = match[2];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function getReferencedSkills(
  content: string,
  skillsByName: Map<string, SkillReferenceChipSkill>,
): SkillReferenceChipSkill[] {
  return extractSkillReferenceNames(content)
    .map((name) => skillsByName.get(name))
    .filter((skill): skill is SkillReferenceChipSkill => Boolean(skill));
}

function SkillReferenceChip({
  skill,
  variant,
}: {
  skill: SkillReferenceChipSkill;
  variant: 'composer' | 'message' | 'user';
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium leading-none',
        variant === 'user'
          ? 'border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground'
          : 'border-border bg-background/80 text-foreground',
        variant === 'composer' ? 'bg-muted/50 text-muted-foreground' : null,
      )}
      title={skill.description}
    >
      <CanvasSkillIcon skill={skill} className="h-4 w-4 border-0 text-[7px]" />
      <span className="min-w-0 truncate">/{skill.name}</span>
    </span>
  );
}

export function SkillReferenceChipRow({
  className,
  content,
  skillsByName,
  variant = 'message',
}: {
  className?: string;
  content: string;
  skillsByName?: Map<string, SkillReferenceChipSkill>;
  variant?: 'composer' | 'message' | 'user';
}) {
  const catalog = useSkillReferenceCatalog();
  const resolvedSkillsByName = skillsByName || catalog;
  const referencedSkills = useMemo(
    () => getReferencedSkills(content, resolvedSkillsByName),
    [content, resolvedSkillsByName],
  );

  if (referencedSkills.length === 0) {
    return null;
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {referencedSkills.map((skill) => (
        <SkillReferenceChip key={skill.name} skill={skill} variant={variant} />
      ))}
    </div>
  );
}
