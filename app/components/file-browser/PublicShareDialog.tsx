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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe2 className="h-5 w-5 text-amber-600" />
            {t('publicShareTitle')}
          </DialogTitle>
          <DialogDescription>{t('publicShareDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
            <div className="flex gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{t('publicShareWarning')}</p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{t('publicShareFiles', { count: fileCount })}</span>
              <Badge variant="secondary">{t('publicShareReadOnly')}</Badge>
            </div>
            <div className="max-h-28 overflow-auto border border-border bg-muted/30 p-2 text-xs">
              {uniquePaths.map((path) => (
                <div key={path} className="truncate font-mono text-muted-foreground" title={path}>
                  {path}
                </div>
              ))}
            </div>
          </div>

          {!hasResults && (
            <div className="space-y-2">
              <span className="text-sm font-medium">{t('publicShareExpiry')}</span>
              <div className="flex flex-wrap gap-2">
                {EXPIRY_OPTIONS.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    variant={expiryDays === option ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setExpiryDays(option)}
                  >
                    {option === 0 ? t('publicShareNoExpiry') : t('publicShareDays', { count: option })}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {shares.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{t('publicShareLinks')}</span>
                <Button variant="outline" size="sm" onClick={copyAll}>
                  <Copy className="h-4 w-4" />
                  {t('publicShareCopyAll')}
                </Button>
              </div>
              <div className="max-h-56 space-y-2 overflow-auto">
                {shares.map((share) => (
                  <div key={share.id} className="border border-border bg-background p-2">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium" title={share.workspacePath}>{share.fileName}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground" title={share.publicUrl}>{share.publicUrl}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {share.expiresAt ? t('publicShareExpiresAt', { date: formatDate(share.expiresAt) }) : t('publicShareNeverExpires')}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
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
            <div className="space-y-2">
              <span className="flex items-center gap-2 text-sm font-medium text-destructive">
                <XCircle className="h-4 w-4" />
                {t('publicShareSkipped', { count: skipped.length })}
              </span>
              <div className="max-h-28 overflow-auto border border-destructive/30 bg-destructive/5 p-2 text-xs">
                {skipped.map((item) => (
                  <div key={`${item.path}:${item.reason}`} className="mb-1">
                    <span className="font-mono">{item.path}</span>
                    <span className="text-muted-foreground"> - {item.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('close')}</Button>
          {!hasResults && (
            <Button onClick={handlePublish} disabled={isPublishing || fileCount === 0}>
              {isPublishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe2 className="h-4 w-4" />}
              {t('publicSharePublish')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
