'use client';

import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { useFileStore } from '@/app/store/file-store';
import { Button } from '@/components/ui/button';

export function FileRevealStatus() {
  const t = useTranslations('notebook');
  const reveal = useFileStore((state) => state.browserReveal);
  if (!reveal || reveal.status === 'visible' || reveal.status === 'ready') return null;
  return (
    <div role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      {reveal.status === 'loading' ? <><Loader2 className="size-3 animate-spin" />{t('revealingFile')}</> : (
        <div>
          <p>{t('fileRevealFailed')}</p>
          <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => {
            void useFileStore.getState().revealAndLoadFile(reveal.path, { workspaceId: reveal.workspaceId });
          }}>{t('retryFileReveal')}</Button>
        </div>
      )}
    </div>
  );
}
