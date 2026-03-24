import { Link } from '@/i18n/navigation';
import { AlertTriangle } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { getGeminiApiKeyFromIntegrations } from '@/app/lib/integrations/env-config';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { VeoStudioClient } from '@/app/apps/veo-studio/components/VeoStudioClient';

export default async function VeoPage() {
  const session = await requirePageSession();
  const t = await getTranslations('veo');
  const tCommon = await getTranslations('common');

  const username = session?.user?.name || session?.user?.email || tCommon('user');
  const geminiApiKey = await getGeminiApiKeyFromIntegrations();

  return (
    <SuitePageLayout title={t('title')} username={username}>
        {!geminiApiKey && (
          <div className="p-4 md:p-6">
            <Card className="border-destructive/50 bg-destructive/10">
              <CardHeader className="px-4 pb-3 sm:px-6">
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  {tCommon('apiKeyRequired')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
                <CardDescription className="text-base text-destructive/80">
                  {tCommon('geminiApiKeyRequired')}
                </CardDescription>
                <Button asChild variant="default" className="w-full sm:w-auto">
                  <Link href="/settings?tab=integrations">
                    {tCommon('goToIntegrations')}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
        
        <VeoStudioClient />
    </SuitePageLayout>
  );
}
