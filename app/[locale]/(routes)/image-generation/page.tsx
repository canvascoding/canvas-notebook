import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { getGeminiApiKeyFromIntegrations, getOpenAIApiKeyFromIntegrations } from '@/app/lib/integrations/env-config';
import { Button } from '@/components/ui/button';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { ImageGenerationClient } from '@/app/apps/image-generation/components/ImageGenerationClient';

type NoticeTone = 'warning' | 'critical';

function IntegrationNotice({
  title,
  description,
  actionLabel,
  tone,
}: {
  title: string;
  description: string;
  actionLabel: string;
  tone: NoticeTone;
}) {
  const toneClasses =
    tone === 'critical'
      ? 'border-destructive/35 bg-destructive/8 text-destructive'
      : 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300';

  return (
    <div className="px-4 pt-4 md:px-6 md:pt-6">
      <div className={`flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-start sm:justify-between ${toneClasses}`}>
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 shrink-0">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-sm leading-6 text-foreground/80 dark:text-foreground/75">{description}</p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <a href="/settings?tab=integrations" target="_blank" rel="noreferrer">
            {actionLabel}
            <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}

export default async function ImageGenerationPage() {
  const session = await requirePageSession();
  const t = await getTranslations('imageGeneration');
  const tCommon = await getTranslations('common');

  const username = session?.user?.name || session?.user?.email || tCommon('user');
  const [geminiApiKey, openaiApiKey] = await Promise.all([
    getGeminiApiKeyFromIntegrations(),
    getOpenAIApiKeyFromIntegrations(),
  ]);

  const hasGemini = !!geminiApiKey;
  const hasOpenAI = !!openaiApiKey;
  const hasAnyProvider = hasGemini || hasOpenAI;

  const availableProviders: string[] = [];
  if (hasGemini) availableProviders.push('gemini');
  if (hasOpenAI) availableProviders.push('openai');

  return (
    <SuitePageLayout title={t('title')} username={username}>
      {!hasAnyProvider ? (
        <IntegrationNotice
          title={t('notices.noProvider.title')}
          description={t('notices.noProvider.description')}
          actionLabel={t('notices.openIntegrations')}
          tone="critical"
        />
      ) : null}
      {hasOpenAI && !hasGemini ? (
        <IntegrationNotice
          title={t('notices.openaiOnly.title')}
          description={t('notices.openaiOnly.description')}
          actionLabel={t('notices.openIntegrations')}
          tone="warning"
        />
      ) : null}
      {hasGemini && !hasOpenAI ? (
        <IntegrationNotice
          title={t('notices.geminiOnly.title')}
          description={t('notices.geminiOnly.description')}
          actionLabel={t('notices.openIntegrations')}
          tone="warning"
        />
      ) : null}
      {hasAnyProvider ? <ImageGenerationClient availableProviders={availableProviders} /> : null}
    </SuitePageLayout>
  );
}
