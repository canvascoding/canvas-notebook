'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Sparkles } from 'lucide-react';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';

import { readNotificationSummary, type NotificationSummary } from '@/app/components/notifications/notification-summary';
import { PromptHero, type HomePromptMode } from './PromptHero';
import { CategoryPills, type CategoryId } from './CategoryPills';
import { InspirationPanel } from './InspirationPanel';
import { HomeAttentionPanel } from './HomeAttentionPanel';
import { HomeFilesPanel } from './HomeFilesPanel';
import { HomeAppLinks } from './HomeAppLinks';
import { MoreToolsSection } from './MoreToolsSection';
import { HomeMobileAppPromo } from '@/app/components/mobile/HomeMobileAppPromo';

export function HomeWorkspaceView({
  showBrowserLab = false,
}: {
  showBrowserLab?: boolean;
}) {
  const t = useTranslations('home');
  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);
  const [promptMode, setPromptMode] = useState<HomePromptMode>('notebook');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === state.activeWorkspaceId));
  const workspaceError = useWorkspaceStore((state) => state.error);
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
    <div className="grid gap-6 pb-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start lg:gap-x-8">
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
        {workspace ? <HomeFilesPanel key={workspace.id} workspace={workspace} /> : <div className="py-8 text-sm text-muted-foreground" role="status">
          {workspaceError ? <><p>{t('start.workspaceFailed')}</p><Button variant="outline" size="sm" className="mt-3" onClick={() => void useWorkspaceStore.getState().hydrateWorkspaces({ force: true })}>{t('start.retry')}</Button></> : t('start.loading')}
        </div>}
      </div>
      <HomeAttentionPanel summary={summary} isLoading={isLoadingSummary} />
      <section className="min-w-0 space-y-3 border-t border-border pt-5 lg:col-start-1 lg:row-start-2" aria-labelledby="home-workspace-prompt">
        <h2 id="home-workspace-prompt" className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-muted-foreground" />{t('start.aiTitle')}</h2>
        <PromptHero key={activeWorkspaceId} onModeChange={setPromptMode} compact />
        {promptMode === 'notebook' ? <div>
          <button type="button" aria-expanded={showSuggestions} aria-controls="home-suggestions" onClick={() => setShowSuggestions((value) => !value)} className="inline-flex min-h-9 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><ChevronDown className={`h-3.5 w-3.5 transition-transform ${showSuggestions ? 'rotate-180' : ''}`} />{t('start.suggestions')}</button>
          {showSuggestions ? <div id="home-suggestions" className="space-y-3 pt-2">
            <CategoryPills activeCategory={activeCategory} onCategoryClick={handleCategoryClick} />
            {activeCategory ? <InspirationPanel category={activeCategory} onClose={() => setActiveCategory(null)} onPromptSelect={handlePromptSelect} /> : null}
          </div> : null}
        </div> : null}
      </section>
      <div className="min-w-0 space-y-5 lg:col-start-1 lg:row-start-3">
        <HomeAppLinks />
        <MoreToolsSection showBrowserLab={showBrowserLab} />
        <HomeMobileAppPromo
          hasPriorityAttention={Boolean(summary?.items.some((item) => item.unread && item.priority === 'high'))}
        />
      </div>
    </div>
  );
}
