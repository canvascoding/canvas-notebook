'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import type { CategoryId } from './CategoryPills';
import { CATEGORY_ICONS } from './CategoryPills';

interface InspirationPanelProps {
  category: CategoryId;
  onClose: () => void;
  onPromptSelect: (prompt: string) => void;
}

export function InspirationPanel({ category, onClose, onPromptSelect }: InspirationPanelProps) {
  const t = useTranslations('home.inspiration');
  const Icon = CATEGORY_ICONS[category];
  const title = t(`${category}.title`);
  const prompts = t.raw(`${category}.prompts`) as string[];

  return (
    <div className="mx-auto w-full max-w-2xl animate-in slide-in-from-top-2 fade-in duration-200">
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="h-4 w-4 text-primary" />
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="divide-y divide-border">
          {prompts.map((prompt, index) => (
            <button
              key={index}
              type="button"
              onClick={() => onPromptSelect(prompt)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              <span className="flex-1">{prompt}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}