'use client';

import { useCallback, useEffect, useState } from 'react';
import { MonitorUp } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { readNotificationSummary, type NotificationSummary } from '@/app/components/notifications/notification-summary';
import { PromptHero } from './PromptHero';
import { CategoryPills, type CategoryId } from './CategoryPills';
import { InspirationPanel } from './InspirationPanel';
import { HomeAttentionPanel } from './HomeAttentionPanel';
import { HomeFocusCards } from './HomeFocusCards';
import { HomeAppLinks } from './HomeAppLinks';
import { MoreToolsSection } from './MoreToolsSection';
import { ToolCard } from './ToolCard';

export function HomeWorkspaceView({
  showBrowserLab = false,
}: {
  showBrowserLab?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations('home');
  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);
  const [summary, setSummary] = useState<NotificationSummary | null>(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(true);
  const browserLabDescription = locale === 'de'
    ? 'Den Browser des Agenten live beobachten, übernehmen und Verbindungen prüfen.'
    : 'Watch the agent browser live, take control, and inspect connections.';

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
    <div className="grid gap-8 pb-10 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
      <div className="min-w-0 space-y-8">
        <section className="space-y-5" aria-labelledby="home-workspace-prompt">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] text-muted-foreground uppercase">{t('hero.eyebrow')}</p>
            <h1 id="home-workspace-prompt" className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">{t('focus.promptTitle')}</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{t('focus.promptDescription')}</p>
          </div>
          <PromptHero />
          <CategoryPills activeCategory={activeCategory} onCategoryClick={handleCategoryClick} />
          {activeCategory ? (
            <InspirationPanel
              category={activeCategory}
              onClose={() => setActiveCategory(null)}
              onPromptSelect={handlePromptSelect}
            />
          ) : null}
        </section>

        <HomeFocusCards summary={summary} />
        <HomeAppLinks />

        <div className="space-y-4">
          {showBrowserLab ? (
            <div data-testid="home-browser-lab-card">
              <ToolCard
                icon={MonitorUp}
                title="Browser Lab"
                description={browserLabDescription}
                href="/browser/lab"
              />
            </div>
          ) : null}
          <MoreToolsSection />
        </div>
      </div>

      <HomeAttentionPanel summary={summary} isLoading={isLoadingSummary} />
    </div>
  );
}
