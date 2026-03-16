import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { auth } from '@/app/lib/auth';
import { getGeminiApiKey } from '@/app/lib/integrations/env-config';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { LogoutButton } from '@/app/components/LogoutButton';
import { ImageGenerationClient } from '@/app/apps/image-generation/components/ImageGenerationClient';

export default async function ImageGenerationPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/login');
  }

  const username = session.user.name || session.user.email;
  const geminiApiKey = await getGeminiApiKey();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="h-16 border-b border-border bg-background/95">
        <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                Suite
              </Link>
            </Button>
            <span className="text-sm font-semibold">Image Generation</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden md:flex flex-col items-end">
              <span className="text-xs font-bold tracking-widest text-muted-foreground uppercase">User</span>
              <span className="text-xs">{username}</span>
            </div>
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        {!geminiApiKey && (
          <div className="p-4 md:p-6">
            <Card className="border-destructive/50 bg-destructive/10">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  API Key erforderlich
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <CardDescription className="text-base text-destructive/80">
                  Diese App benötigt einen GEMINI_API_KEY. Bitte konfiguriere diesen im Integrations-Tab.
                </CardDescription>
                <Button asChild variant="default">
                  <Link href="/settings?tab=integrations">
                    Zu Integrations
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
        <ImageGenerationClient />
      </main>
    </div>
  );
}
