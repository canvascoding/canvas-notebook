import type { ComponentType, ReactNode } from 'react';
import {
  BookOpen,
  CalendarDays,
  Clapperboard,
  FileImage,
  FileSpreadsheet,
  FileText,
  Globe,
  Image as ImageIcon,
  Languages,
  Palette,
  Presentation,
  Search,
  Sparkles,
  Wrench,
} from 'lucide-react';

const SKILL_ICON_BY_NAME: Record<string, ComponentType<{ className?: string }>> = {
  'ad-localization': Languages,
  'algorithmic-art': Sparkles,
  'brand-guidelines': Palette,
  'brave-search': Search,
  'browser-tools': Globe,
  'canvas-design': Palette,
  'doc-coauthoring': BookOpen,
  docx: FileText,
  gccli: CalendarDays,
  'image-generation': ImageIcon,
  pdf: FileText,
  pptx: Presentation,
  qmd: BookOpen,
  transcribe: FileText,
  'video-generation': Clapperboard,

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

export function renderSkillIcon(
  skillName: string,
  description?: string,
  className: string = 'h-4 w-4 text-primary',
): ReactNode {
  const Icon = getSkillIcon(skillName, description);
  return <Icon className={className} />;
}
