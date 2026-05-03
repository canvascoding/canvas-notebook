'use client';

import React from 'react';

import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat';


import { ThemeToggle } from '@/app/components/ThemeToggle';
import { LogoutButton } from '@/app/components/LogoutButton';
import { AppLauncher } from '@/app/components/AppLauncher';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '@/app/lib/chat/constants';

export function ChatShell() {
  const t = useTranslations('chat');
  const tCommon = useTranslations('common');

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      <header className="z-40 h-16 flex-shrink-0 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-full items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">{tCommon('suite')}</span>
              </Link>
            </Button>
            <h1 className="hidden md:block text-lg md:text-2xl font-bold truncate">{t('title')}</h1>
          </div>
            <div className="flex items-center gap-1.5 md:gap-4">
              <AppLauncher />
              <ThemeToggle />
              <LogoutButton />
            </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex-1 min-w-0 overflow-hidden">
          <CanvasAgentChat
            initialPromptStorageKey={CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY}
            showSkillsLink={true}
            hideNavHeader={true}
            isSurfaceVisible={true}
          />
        </div>
      </main>
    </div>
  );
}
