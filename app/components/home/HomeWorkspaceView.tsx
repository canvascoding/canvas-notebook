'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { NotebookPen, Workflow, ImageIcon, Clapperboard, Globe, FolderOpen } from 'lucide-react';
import { PromptHero } from './PromptHero';
import { CategoryPills, type CategoryId } from './CategoryPills';
import { InspirationPanel } from './InspirationPanel';
import { ToolCard } from './ToolCard';
import { MoreToolsSection } from './MoreToolsSection';

export function HomeWorkspaceView() {
  const t = useTranslations('home');
  const tApps = useTranslations('home.apps');
  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);

  const handleCategoryClick = (id: CategoryId) => {
    setActiveCategory((prev) => (prev === id ? null : id));
  };

  const handlePromptSelect = (prompt: string) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-prompt-hero-textarea]');
    if (textarea) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      nativeInputValueSetter?.call(textarea, prompt);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
      textarea.setSelectionRange(prompt.length, prompt.length);
    }
  };

  const handleClosePanel = () => {
    setActiveCategory(null);
  };

  return (
    <div className="flex flex-col gap-6 pb-10">
      <PromptHero />
      <CategoryPills activeCategory={activeCategory} onCategoryClick={handleCategoryClick} />
      {activeCategory && (
        <InspirationPanel
          category={activeCategory}
          onClose={handleClosePanel}
          onPromptSelect={handlePromptSelect}
        />
      )}

      <section id="onboarding-home-workspace">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
          {t('sections.workspace')}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ToolCard
            icon={NotebookPen}
            title={tApps('notebook.title')}
            description={tApps('notebook.description')}
            href="/notebook"
          />
          <ToolCard
            icon={FolderOpen}
            title={tApps('files.title')}
            description={tApps('files.description')}
            href="/files"
          />
          <ToolCard
            icon={Workflow}
            title={tApps('automations.title')}
            description={tApps('automations.description')}
            href="/automationen"
          />
        </div>
      </section>

      <section id="onboarding-home-create">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
          {t('sections.create')}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ToolCard
            icon={ImageIcon}
            title={tApps('imageGeneration.title')}
            description={tApps('imageGeneration.description')}
            href="/image-generation"
          />
          <ToolCard
            icon={Clapperboard}
            title={tApps('veo.title')}
            description={tApps('veo.description')}
            href="/veo"
          />
          <ToolCard
            icon={Globe}
            title={tApps('nanoBanana.title')}
            description={tApps('nanoBanana.description')}
            href="/nano-banana-localizer"
          />
        </div>
      </section>

      <MoreToolsSection />
    </div>
  );
}