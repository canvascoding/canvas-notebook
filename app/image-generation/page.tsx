import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { requirePageSession } from '@/app/lib/auth-guards';
import { getGeminiApiKeyFromIntegrations } from '@/app/lib/integrations/env-config';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { ImageGenerationClient } from '@/app/apps/image-generation/components/ImageGenerationClient';

export default async function ImageGenerationPage() {
  const session = await requirePageSession();

  const username = session.user.name || session.user.email;
  const geminiApiKey = await getGeminiApiKeyFromIntegrations();

  return (
    <SuitePageLayout title="Image Generation" username={username}>
        {!geminiApiKey && (
          <div className="p-4 md:p-6">
            <Card className="border-destructive/50 bg-destructive/10">
              <CardHeader className="px-4 pb-3 sm:px-6">
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  API Key erforderlich
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
                <CardDescription className="text-base text-destructive/80">
                  Diese App benötigt einen GEMINI_API_KEY. Bitte konfiguriere diesen im Integrations-Tab.
                </CardDescription>
                <Button asChild variant="default" className="w-full sm:w-auto">
                  <Link href="/settings?tab=integrations">
                    Zu Integrations
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
        <ImageGenerationClient />
    </SuitePageLayout>
  );
}
