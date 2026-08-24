'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Megaphone, Sparkles, Clapperboard, BriefcaseBusiness, FileText } from 'lucide-react';

export type CategoryId = 'campaign' | 'creative' | 'video' | 'strategy' | 'document';

const CATEGORY_ICONS: Record<CategoryId, React.ComponentType<{ className?: string }>> = {
  campaign: Megaphone,
  creative: Sparkles,
  video: Clapperboard,
  strategy: BriefcaseBusiness,
  document: FileText,
};

const CATEGORY_IDS: CategoryId[] = ['campaign', 'creative', 'video', 'strategy', 'document'];

interface CategoryPillsProps {
  activeCategory: CategoryId | null;
  onCategoryClick: (id: CategoryId) => void;
}

export function CategoryPills({ activeCategory, onCategoryClick }: CategoryPillsProps) {
  const t = useTranslations('home.categories');

  return (
    <div className="-mx-3 flex snap-x snap-mandatory items-center gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0">
      {CATEGORY_IDS.map((id) => {
        const Icon = CATEGORY_ICONS[id];
        const isActive = activeCategory === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onCategoryClick(id)}
            className={`inline-flex h-10 shrink-0 snap-start items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors ${
              isActive
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:bg-accent hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {t(id)}
          </button>
        );
      })}
    </div>
  );
}

export { CATEGORY_IDS, CATEGORY_ICONS };
