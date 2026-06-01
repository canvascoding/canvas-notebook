'use client';

import { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, Globe2, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

interface PublicShareResult {
  id: string;
  workspacePath: string;
  fileName: string;
  publicUrl: string;
  expiresAt: string | null;
  status: string;
}

interface PublicShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: string[];
  onPublished?: () => void;
}

type ExpiryOption = 7 | 30 | 90 | 0;

const EXPIRY_OPTIONS: ExpiryOption[] = [30, 7, 90, 0];

function formatDate(value: string | null) {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function PublicShareDialog({ open, onOpenChange, paths, onPublished }: PublicShareDialogProps) {
  const t = useTranslations('notebook');
  const [expiryDays, setExpiryDays] = useState<ExpiryOption>(30);
  const [isPublishing, setIsPublishing] = useState(false);
  const [shares, setShares] = useState<PublicShareResult[]>([]);
  const [skipped, setSkipped] = useState<Array<{ path: string; reason: string }>>([]);

  const uniquePaths = useMemo(() => Array.from(new Set(paths.filter(Boolean))), [paths]);
  const fileCount = uniquePaths.length;
  const hasResults = shares.length > 0 || skipped.length > 0;

  useEffect(() => {
    if (!open) {
      setExpiryDays(30);
      setIsPublishing(false);
      setShares([]);
      setSkipped([]);
    }
  }, [open]);

  const handlePublish = async () => {
    setIsPublishing(true);
    setSkipped([]);
    try {
      const response = await fetch('/api/security/public-shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          paths: uniquePaths,
          expiresInDays: expiryDays === 0 ? null : expiryDays,
          reason: 'Created from file browser',
        }),
      });

      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('publicShareCreateFailed'));
      }

      setShares(payload.shares || []);
      setSkipped(payload.skipped || []);
      onPublished?.();
      if ((payload.shares || []).length > 0) {
        toast.success(t('publicShareCreated', { count: (payload.shares || []).length }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('publicShareCreateFailed');
      toast.error(message);
    } finally {
      setIsPublishing(false);
    }
  };

  const copyText = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(successMessage);
    } catch {
      toast.error(t('publicShareCopyFailed'));
    }
  };

  const copyAll = async () => {
    await copyText(shares.map((share) => share.publicUrl).join('\n'), t('publicShareCopiedAll'));
  };

  const openUrl = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-2xl min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)]">
        <DialogHeader className="min-w-0 px-4 pb-3 pt-5 pr-12 sm:px-6 sm:pt-6 sm:pr-12">
          <DialogTitle className="flex min-w-0 items-center gap-2 text-base leading-tight sm:text-lg">
            <Globe2 className="h-5 w-5 text-amber-600" />
            <span className="min-w-0 truncate">{t('publicShareTitle')}</span>
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed sm:text-base">
            {t('publicShareDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4 sm:px-6">
          <div className="min-w-0 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
            <div className="flex min-w-0 gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="min-w-0 break-words leading-relaxed">{t('publicShareWarning')}</p>
            </div>
          </div>

          <div className="min-w-0 space-y-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{t('publicShareFiles', { count: fileCount })}</span>
              <Badge variant="secondary">{t('publicShareReadOnly')}</Badge>
            </div>
            <div className="max-h-32 min-w-0 overflow-y-auto border border-border bg-muted/30 p-2 text-xs">
              {uniquePaths.map((path) => (
                <div key={path} className="break-all font-mono text-muted-foreground" title={path}>
                  {path}
                </div>
              ))}
            </div>
          </div>

          {!hasResults && (
            <div className="min-w-0 space-y-2">
              <span className="text-sm font-medium">{t('publicShareExpiry')}</span>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                {EXPIRY_OPTIONS.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    variant={expiryDays === option ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setExpiryDays(option)}
                    className="w-full sm:w-auto"
                  >
                    {option === 0 ? t('publicShareNoExpiry') : t('publicShareDays', { count: option })}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {shares.length > 0 && (
            <div className="min-w-0 space-y-2">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{t('publicShareLinks')}</span>
                <Button variant="outline" size="sm" onClick={copyAll}>
                  <Copy className="h-4 w-4" />
                  {t('publicShareCopyAll')}
                </Button>
              </div>
              <div className="max-h-64 min-w-0 space-y-2 overflow-y-auto">
                {shares.map((share) => (
                  <div key={share.id} className="min-w-0 border border-border bg-background p-2">
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="break-all text-sm font-medium" title={share.workspacePath}>{share.fileName}</div>
                        <div className="break-all font-mono text-xs text-muted-foreground" title={share.publicUrl}>{share.publicUrl}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {share.expiresAt ? t('publicShareExpiresAt', { date: formatDate(share.expiresAt) }) : t('publicShareNeverExpires')}
                        </div>
                      </div>
                      <div className="flex shrink-0 justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => copyText(share.publicUrl, t('publicShareCopied'))}>
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => openUrl(share.publicUrl)}>
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {skipped.length > 0 && (
            <div className="min-w-0 space-y-2">
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-destructive">
                <XCircle className="h-4 w-4" />
                {t('publicShareSkipped', { count: skipped.length })}
              </span>
              <div className="max-h-32 min-w-0 overflow-y-auto border border-destructive/30 bg-destructive/5 p-2 text-xs">
                {skipped.map((item) => (
                  <div key={`${item.path}:${item.reason}`} className="mb-1 break-all">
                    <span className="font-mono">{item.path}</span>
                    <span className="text-muted-foreground"> - {item.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-border px-4 py-3 sm:px-6">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">{t('close')}</Button>
          {!hasResults && (
            <Button onClick={handlePublish} disabled={isPublishing || fileCount === 0} className="w-full sm:w-auto">
              {isPublishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe2 className="h-4 w-4" />}
              {t('publicSharePublish')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
