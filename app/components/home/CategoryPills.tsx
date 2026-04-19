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
    <div className="flex flex-wrap items-center justify-center gap-2">
      {CATEGORY_IDS.map((id) => {
        const Icon = CATEGORY_ICONS[id];
        const isActive = activeCategory === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onCategoryClick(id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
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