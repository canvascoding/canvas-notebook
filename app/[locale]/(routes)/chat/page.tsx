import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { requirePageSession } from '@/app/lib/auth-guards';
import { buildNotebookChatRedirectHref } from '@/app/lib/chat/chat-navigation-intent';
import { redirect } from '@/i18n/navigation';

type ChatPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('chat');

  return {
    title: t('metadataTitle'),
    description: t('metadataDescription'),
  };
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  await requirePageSession();

  const [locale, resolvedSearchParams] = await Promise.all([
    getLocale(),
    searchParams ?? Promise.resolve({}),
  ]);

  redirect({
    href: buildNotebookChatRedirectHref(resolvedSearchParams),
    locale,
  });
}
