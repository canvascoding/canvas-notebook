'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { readNotificationSummary, type NotificationSummary } from '@/app/components/notifications/notification-summary';
import { PromptHero, type HomePromptMode } from './PromptHero';
import { CategoryPills, type CategoryId } from './CategoryPills';
import { InspirationPanel } from './InspirationPanel';
import { HomeAttentionPanel } from './HomeAttentionPanel';
import { HomeFocusCards } from './HomeFocusCards';
import { HomeAppLinks } from './HomeAppLinks';
import { MoreToolsSection } from './MoreToolsSection';

export function HomeWorkspaceView({
  showBrowserLab = false,
}: {
  showBrowserLab?: boolean;
}) {
  const t = useTranslations('home');
  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);
  const [promptMode, setPromptMode] = useState<HomePromptMode>('notebook');
  const [summary, setSummary] = useState<NotificationSummary | null>(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(true);
  const refreshSummary = useCallback(async () => {
    try {
      setSummary(await readNotificationSummary());
    } catch {
      setSummary(null);
    } finally {
      setIsLoadingSummary(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      void refreshSummary();
    }, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSummary();
    }, 30_000);
    const refreshAfterUpdate = () => window.setTimeout(() => void refreshSummary(), 100);
    window.addEventListener('session_updated', refreshAfterUpdate);
    window.addEventListener('todo_updated', refreshAfterUpdate);
    window.addEventListener('notification_summary_updated', refreshAfterUpdate);

    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener('session_updated', refreshAfterUpdate);
      window.removeEventListener('todo_updated', refreshAfterUpdate);
      window.removeEventListener('notification_summary_updated', refreshAfterUpdate);
    };
  }, [refreshSummary]);

  const handleCategoryClick = (id: CategoryId) => {
    setActiveCategory((previous) => (previous === id ? null : id));
  };

  const handlePromptSelect = (prompt: string) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-prompt-hero-textarea]');
    if (!textarea) return;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    nativeInputValueSetter?.call(textarea, prompt);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(prompt.length, prompt.length);
  };

  return (
    <div className="grid gap-6 pb-8 sm:gap-8 sm:pb-10 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
      <div className="min-w-0 space-y-6 sm:space-y-8">
        <section className="space-y-4 sm:space-y-5" aria-labelledby="home-workspace-prompt">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] text-muted-foreground uppercase">{t('hero.eyebrow')}</p>
            <h1 id="home-workspace-prompt" className="mt-2 text-[1.65rem] font-semibold leading-tight tracking-tight sm:text-3xl">{t('focus.promptTitle')}</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{t('focus.promptDescription')}</p>
          </div>
          <PromptHero onModeChange={setPromptMode} />
          {promptMode === 'notebook' ? (
            <>
              <CategoryPills activeCategory={activeCategory} onCategoryClick={handleCategoryClick} />
              {activeCategory ? (
                <InspirationPanel
                  category={activeCategory}
                  onClose={() => setActiveCategory(null)}
                  onPromptSelect={handlePromptSelect}
                />
              ) : null}
            </>
          ) : null}
        </section>

        <HomeFocusCards summary={summary} />
        <HomeAppLinks />

        <MoreToolsSection showBrowserLab={showBrowserLab} />
      </div>

      <HomeAttentionPanel summary={summary} isLoading={isLoadingSummary} />
    </div>
  );
}
