import { getTranslations } from 'next-intl/server';

import { KnowledgeGraphShell } from '@/app/apps/knowledge-graph/components/KnowledgeGraphShell';
import { requirePageSession } from '@/app/lib/auth-guards';

export async function generateMetadata() {
  const t = await getTranslations('knowledgeGraph');
  return {
    title: `${t('title')} - Canvas Notebook`,
    description: t('description'),
  };
}

export default async function KnowledgeGraphPage() {
  await requirePageSession();
  return <KnowledgeGraphShell />;
}
