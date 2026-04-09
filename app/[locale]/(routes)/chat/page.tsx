import type { Metadata } from 'next';
import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat';
import { LanguageSwitcher } from '@/app/components/language-switcher';
import { NotebookNavButton } from '@/app/components/NotebookNavButton';
import { LogoutButton } from '@/app/components/LogoutButton';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { requirePageSession } from '@/app/lib/auth-guards';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '@/app/lib/chat/constants';
import { Button } from '@/components/ui/button';
import ChatPageClient from './chat-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('chat');

  return {
    title: t('metadataTitle'),
    description: t('metadataDescription'),
  };
}

export default async function ChatPage() {
  const session = await requirePageSession();
  const t = await getTranslations('chat');
  const tCommon = await getTranslations('common');

  const username = session?.user?.name || session?.user?.email || 'User';

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <ChatPageClient />
      <header className="z-40 h-16 flex-shrink-0 border-b border-border bg-background/95">
        <div className="mx-auto flex h-full items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">{tCommon('suite')}</span>
              </Link>
            </Button>
            <Image src="/logo.jpg" alt={t('logoAlt')} width={32} height={32} className="shrink-0 border border-border" />
            <h1 className="hidden md:block text-lg md:text-2xl font-bold truncate">{t('title')}</h1>
          </div>
          <div className="flex items-center gap-1.5 md:gap-4">
            <NotebookNavButton />
            <LanguageSwitcher />
            <ThemeToggle />
            <Button asChild variant="outline" size="sm" className="hidden gap-2 px-2 sm:px-3 md:inline-flex">
              <Link href="/usage">{t('usage')}</Link>
            </Button>
            <div className="hidden lg:flex flex-col items-end shrink-0">
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">{t('userLabel')}</span>
              <span className="text-xs text-foreground/90">{username}</span>
            </div>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-hidden">
        <CanvasAgentChat 
          initialPromptStorageKey={CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY}
          showSkillsLink={true}
        />
      </main>
    </div>
  );
}
