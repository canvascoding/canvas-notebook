import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat';
import { requirePageSession } from '@/app/lib/auth-guards';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '@/app/lib/chat/constants';
import ChatPageClient from './chat-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('chat');

  return {
    title: t('metadataTitle'),
    description: t('metadataDescription'),
  };
}

export default async function ChatPage() {
  await requirePageSession();

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <ChatPageClient />
      <main className="flex-1 min-h-0 overflow-hidden">
        <CanvasAgentChat 
          initialPromptStorageKey={CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY}
          showSkillsLink={true}
        />
      </main>
    </div>
  );
}
