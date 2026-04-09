import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ChatShell } from './chat-shell';
import { requirePageSession } from '@/app/lib/auth-guards';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('chat');

  return {
    title: t('metadataTitle'),
    description: t('metadataDescription'),
  };
}

export default async function ChatPage() {
  await requirePageSession();

  return <ChatShell />;
}