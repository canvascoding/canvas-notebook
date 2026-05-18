'use client';

import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface HtmlPreviewConsentProps {
  open: boolean;
  fileName: string;
  onAccept: () => void;
  onDecline: () => void;
}

export function HtmlPreviewConsent({ open, fileName, onAccept, onDecline }: HtmlPreviewConsentProps) {
  const t = useTranslations('notebook');

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <AlertTriangle className="text-amber-500" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t('htmlPreviewConfirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('htmlPreviewConfirmDescription', { fileName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onDecline}>
            {t('htmlPreviewDecline')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={onAccept}>
            {t('htmlPreviewAccept')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface HtmlPreviewBlockedProps {
  fileName: string;
  onOpen: () => void;
}

export function HtmlPreviewBlocked({ fileName, onOpen }: HtmlPreviewBlockedProps) {
  const t = useTranslations('notebook');

  return (
    <div className="flex h-full items-center justify-center bg-background p-6 text-center">
      <div className="max-w-md space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md bg-muted">
          <AlertTriangle className="h-6 w-6 text-amber-500" />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{t('htmlPreviewBlockedTitle')}</p>
          <p className="text-sm text-muted-foreground">
            {t('htmlPreviewBlockedDescription', { fileName })}
          </p>
        </div>
        <Button variant="secondary" onClick={onOpen}>
          {t('htmlPreviewAccept')}
        </Button>
      </div>
    </div>
  );
}
