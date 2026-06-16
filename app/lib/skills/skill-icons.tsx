'use client';

import { useState, type ComponentType, type ReactNode } from 'react';
import {
  BookOpen,
  CalendarDays,
  Clapperboard,
  FileImage,
  FileSpreadsheet,
  FileText,
  Globe,
  Languages,
  Palette,
  Presentation,
  Sparkles,
  Wrench,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type { CanvasSkillInterface } from './canvas-skill-manifest';

export type CanvasSkillIconSource = {
  name: string;
  title?: string;
  description?: string;
  interface?: CanvasSkillInterface;
  plugin?: {
    name: string;
    skillAssetPath?: string;
  };
};

const SKILL_ICON_BY_NAME: Record<string, ComponentType<{ className?: string }>> = {
  'ad-localization': Languages,
  'algorithmic-art': Sparkles,
  'brand-guidelines': Palette,
  'browser-tools': Globe,
  'canvas-design': Palette,
  'doc-coauthoring': BookOpen,
  docx: FileText,
  gccli: CalendarDays,
  pdf: FileText,
  pptx: Presentation,
  qmd: BookOpen,
  transcribe: FileText,
  xlsx: FileSpreadsheet,
  'youtube-transcript': FileText,
};

const KEYWORD_ICON_MATCHERS: Array<{
  keywords: string[];
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { keywords: ['image', 'photo'], Icon: FileImage },
  { keywords: ['video', 'film'], Icon: Clapperboard },
  { keywords: ['pdf', 'doc', 'text', 'transcript'], Icon: FileText },
  { keywords: ['sheet', 'xlsx', 'excel', 'table'], Icon: FileSpreadsheet },
  { keywords: ['slide', 'ppt', 'presentation'], Icon: Presentation },
  { keywords: ['search', 'browser', 'web'], Icon: Globe },
  { keywords: ['brand', 'design', 'art'], Icon: Palette },
  { keywords: ['calendar'], Icon: CalendarDays },
  { keywords: ['translate', 'localiz', 'language'], Icon: Languages },
];

export function getSkillIcon(skillName: string, description?: string): ComponentType<{ className?: string }> {
  const normalizedName = skillName.trim().toLowerCase();
  const byName = SKILL_ICON_BY_NAME[normalizedName];
  if (byName) {
    return byName;
  }

  const searchableText = `${normalizedName} ${(description || '').toLowerCase()}`;
  const keywordMatch = KEYWORD_ICON_MATCHERS.find(({ keywords }) =>
    keywords.some((keyword) => searchableText.includes(keyword)),
  );

  return keywordMatch?.Icon || Wrench;
}

function normalizeAssetPath(assetPath?: string): string | null {
  const normalized = assetPath?.trim();
  if (!normalized) return null;
  return normalized.replace(/^\.\//, '').replace(/^\/+/, '');
}

function resolveSkillAssetUrl(skill: CanvasSkillIconSource, assetPath?: string): string | null {
  const normalized = normalizeAssetPath(assetPath);
  if (!normalized) return null;

  if (/^https?:\/\//i.test(normalized) || normalized.startsWith('data:')) {
    return normalized;
  }

  if (skill.plugin?.name && skill.plugin.skillAssetPath !== undefined) {
    return `/api/plugins/asset?plugin=${encodeURIComponent(skill.plugin.name)}&path=${encodeURIComponent(`${skill.plugin.skillAssetPath}/${normalized}`)}`;
  }

  return `/api/skills/asset?path=${encodeURIComponent(`${skill.name}/${normalized}`)}`;
}

function getSkillInitials(skill: CanvasSkillIconSource): string {
  const label = skill.interface?.displayName || skill.title || skill.name;
  const words = label
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return '?';
  }

  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function isSafeHexColor(value?: string): value is string {
  return Boolean(value && /^#[0-9a-f]{6}$/i.test(value));
}

function CanvasSkillInitialsIcon({
  skill,
  className,
}: {
  skill: CanvasSkillIconSource;
  className?: string;
}) {
  const brandColor = skill.interface?.brandColor;
  const colorStyle = isSafeHexColor(brandColor)
    ? { backgroundColor: brandColor, color: '#fff', borderColor: brandColor }
    : undefined;

  return (
    <span
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-primary/10 text-xs font-semibold uppercase text-primary',
        'leading-none',
        className,
      )}
      style={colorStyle}
      aria-hidden="true"
    >
      {getSkillInitials(skill)}
    </span>
  );
}

export function CanvasSkillIcon({
  skill,
  className,
  imageClassName,
}: {
  skill: CanvasSkillIconSource;
  className?: string;
  imageClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const iconPath = skill.interface?.iconSmall || skill.interface?.iconLarge;
  const iconUrl = failed ? null : resolveSkillAssetUrl(skill, iconPath);

  if (iconUrl) {
    return (
      <span
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-background',
          className,
        )}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- Skill assets are local runtime files served through an authenticated API route. */}
        <img
          src={iconUrl}
          alt=""
          className={cn('h-full w-full object-cover', imageClassName)}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return <CanvasSkillInitialsIcon skill={skill} className={className} />;
}

export function renderSkillIcon(
  skillName: string,
  description?: string,
  className: string = 'h-4 w-4 text-primary',
): ReactNode {
  return (
    <CanvasSkillIcon
      skill={{ name: skillName, description }}
      className={className}
    />
  );
}
