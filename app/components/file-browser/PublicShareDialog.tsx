'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, Globe2, Loader2, ShieldAlert, Unlink, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';

interface PublicShareResult {
  id: string;
  workspacePath: string;
  fileName: string;
  mimeType?: string;
  securityMode?: 'strict' | 'interactive';
  shortCode?: string | null;
  shortUrl?: string;
  shortPath?: string;
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

function normalizePathForCompare(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function primaryShareUrl(share: PublicShareResult) {
  return share.shortUrl || share.publicUrl;
}

function isHtmlPath(path: string) {
  return /\.(html|htm)$/i.test(path);
}

function shareSecurityMode(share: PublicShareResult) {
  return share.securityMode === 'interactive' ? 'interactive' : 'strict';
}

function shareDisplayKey(share: PublicShareResult) {
  return share.id || `${normalizePathForCompare(share.workspacePath)}:${primaryShareUrl(share)}`;
}

function dedupeShares(shares: PublicShareResult[]) {
  const seen = new Set<string>();
  return shares.filter((share) => {
    const key = shareDisplayKey(share);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function PublicShareDialog({ open, onOpenChange, paths, onPublished }: PublicShareDialogProps) {
  const t = useTranslations('notebook');
  const [expiryDays, setExpiryDays] = useState<ExpiryOption>(30);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [revokingIds, setRevokingIds] = useState<Set<string>>(new Set());
  const [interactiveHtmlEnabled, setInteractiveHtmlEnabled] = useState(false);
  const [existingShares, setExistingShares] = useState<PublicShareResult[]>([]);
  const [shares, setShares] = useState<PublicShareResult[]>([]);
  const [skipped, setSkipped] = useState<Array<{ path: string; reason: string }>>([]);

  const uniquePaths = useMemo(() => Array.from(new Set(paths.filter(Boolean))), [paths]);
  const fileCount = uniquePaths.length;
  const hasResults = shares.length > 0 || skipped.length > 0;
  const canUseInteractiveHtml = uniquePaths.length === 1 && isHtmlPath(uniquePaths[0] || '');
  const requestedSecurityMode: 'strict' | 'interactive' = canUseInteractiveHtml && interactiveHtmlEnabled
    ? 'interactive'
    : 'strict';
  const existingSharePaths = useMemo(
    () => new Set(existingShares.map((share) => normalizePathForCompare(share.workspacePath))),
    [existingShares]
  );
  const publishablePaths = useMemo(
    () => uniquePaths.filter((path) => !existingSharePaths.has(normalizePathForCompare(path))),
    [uniquePaths, existingSharePaths]
  );
  const displayExistingShares = useMemo(() => dedupeShares(existingShares), [existingShares]);
  const existingShareForSelectedHtml = useMemo(() => {
    if (!canUseInteractiveHtml) return null;
    const selectedPath = normalizePathForCompare(uniquePaths[0] || '');
    return displayExistingShares.find((share) => normalizePathForCompare(share.workspacePath) === selectedPath) || null;
  }, [canUseInteractiveHtml, uniquePaths, displayExistingShares]);
  const isUpdatingSecurityMode = Boolean(
    existingShareForSelectedHtml
    && shareSecurityMode(existingShareForSelectedHtml) !== requestedSecurityMode
  );
  const actionablePaths = isUpdatingSecurityMode ? uniquePaths : publishablePaths;
  const displayNewShares = useMemo(() => {
    const existingKeys = new Set(displayExistingShares.map(shareDisplayKey));
    const existingUrls = new Set(displayExistingShares.map(primaryShareUrl));

    return dedupeShares(shares).filter((share) => {
      if (existingKeys.has(shareDisplayKey(share))) return false;
      return !existingUrls.has(primaryShareUrl(share));
    });
  }, [shares, displayExistingShares]);

  const resetDialogState = useCallback(() => {
    setExpiryDays(30);
    setIsPublishing(false);
    setIsChecking(false);
    setRevokingIds(new Set());
    setInteractiveHtmlEnabled(false);
    setExistingShares([]);
    setShares([]);
    setSkipped([]);
  }, []);

  useEffect(() => {
    if (!open) {
      const resetTimer = window.setTimeout(resetDialogState, 0);
      return () => window.clearTimeout(resetTimer);
    }

    if (uniquePaths.length === 0) return;

    const controller = new AbortController();
    const loadExistingShares = async () => {
      setIsChecking(true);
      try {
        const params = new URLSearchParams({
          status: 'active',
          limit: '1000',
        });
        uniquePaths.forEach((path) => params.append('path', path));

        const response = await fetch(`/api/security/public-shares?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || t('publicShareCheckFailed'));
        }
        setExistingShares(payload.shares || []);
      } catch (error) {
        if (controller.signal.aborted) return;
        toast.error(error instanceof Error ? error.message : t('publicShareCheckFailed'));
      } finally {
        if (!controller.signal.aborted) setIsChecking(false);
      }
    };

    void loadExistingShares();

    return () => controller.abort();
  }, [open, uniquePaths, t, resetDialogState]);

  const handlePublish = async () => {
    if (actionablePaths.length === 0) {
      toast.info(t('publicShareAlreadyPublishedAll'));
      return;
    }

    setIsPublishing(true);
    setSkipped([]);
    try {
      const response = await fetch('/api/security/public-shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          paths: actionablePaths,
          securityMode: requestedSecurityMode,
          expiresInDays: expiryDays === 0 ? null : expiryDays,
          reason: 'Created from file browser',
        }),
      });

      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('publicShareCreateFailed'));
      }

      const nextShares = payload.shares || [];
      setShares(nextShares);
      setSkipped(payload.skipped || []);
      if (isUpdatingSecurityMode && nextShares.length > 0) {
        setExistingShares((current) => {
          const byId = new Map(current.map((share) => [share.id, share]));
          nextShares.forEach((share: PublicShareResult) => byId.set(share.id, share));
          return Array.from(byId.values());
        });
      }
      onPublished?.();
      if ((payload.shares || []).length > 0) {
        toast.success(isUpdatingSecurityMode
          ? t('publicShareUpdated')
          : t('publicShareCreated', { count: (payload.shares || []).length }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('publicShareCreateFailed');
      toast.error(message);
    } finally {
      setIsPublishing(false);
    }
  };

  const handleUnpublish = async (share: PublicShareResult) => {
    setRevokingIds((current) => new Set(current).add(share.id));
    try {
      const response = await fetch(`/api/security/public-shares/${encodeURIComponent(share.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('publicShareRevokeFailed'));
      }

      setExistingShares((current) => current.filter((item) => item.id !== share.id));
      setShares((current) => current.filter((item) => item.id !== share.id));
      onPublished?.();
      toast.success(t('publicShareUnpublished'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('publicShareRevokeFailed'));
    } finally {
      setRevokingIds((current) => {
        const next = new Set(current);
        next.delete(share.id);
        return next;
      });
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

  const copyShareUrls = async (shareList: PublicShareResult[]) => {
    await copyText(shareList.map(primaryShareUrl).join('\n'), t('publicShareCopiedAll'));
  };

  const openUrl = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const renderShareCard = (share: PublicShareResult) => {
    const isRevoking = revokingIds.has(share.id);
    const shareUrl = primaryShareUrl(share);

    return (
      <div key={share.id} className="min-w-0 border border-border bg-background p-2">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="break-all text-sm font-medium" title={share.workspacePath}>{share.fileName}</div>
            <div className="mt-1 break-all bg-muted/40 px-2 py-1 font-mono text-xs" title={shareUrl}>{shareUrl}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {share.expiresAt ? t('publicShareExpiresAt', { date: formatDate(share.expiresAt) }) : t('publicShareNeverExpires')}
            </div>
            <Badge variant={shareSecurityMode(share) === 'interactive' ? 'outline' : 'secondary'} className="mt-2">
              {shareSecurityMode(share) === 'interactive' ? t('publicShareModeInteractive') : t('publicShareModeStrict')}
            </Badge>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            <Button variant="ghost" size="icon-sm" onClick={() => copyText(shareUrl, t('publicShareCopied'))}>
              <Copy className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => openUrl(shareUrl)}>
              <ExternalLink className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => void handleUnpublish(share)}
              disabled={isRevoking}
            >
              {isRevoking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
              {t('publicShareUnpublish')}
            </Button>
          </div>
        </div>
      </div>
    );
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
              <p className="min-w-0 break-words leading-relaxed">
                {interactiveHtmlEnabled ? t('publicShareWarningInteractive') : t('publicShareWarning')}
              </p>
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

          {isChecking && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('publicShareChecking')}
            </div>
          )}

          {displayExistingShares.length > 0 && (
            <div className="min-w-0 space-y-2">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{t('publicShareAlreadyPublished')}</span>
                {displayExistingShares.length > 1 && (
                  <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                    {displayExistingShares.length}
                  </Badge>
                )}
              </div>
              <div className="max-h-64 min-w-0 space-y-2 overflow-y-auto">
                {displayExistingShares.map((share) => renderShareCard(share))}
              </div>
            </div>
          )}

          {!hasResults && canUseInteractiveHtml && (
            <div className="min-w-0 border border-border bg-background p-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <Label htmlFor="interactive-html-share" className="text-sm font-medium">
                    {t('publicShareInteractiveHtml')}
                  </Label>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {t('publicShareInteractiveHtmlDescription')}
                  </p>
                </div>
                <Switch
                  id="interactive-html-share"
                  checked={interactiveHtmlEnabled}
                  onCheckedChange={setInteractiveHtmlEnabled}
                  aria-label={t('publicShareInteractiveHtml')}
                />
              </div>
            </div>
          )}

          {!hasResults && actionablePaths.length > 0 && (
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

          {displayNewShares.length > 0 && (
            <div className="min-w-0 space-y-2">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{t('publicShareLinks')}</span>
                {displayNewShares.length > 1 && (
                  <Button variant="outline" size="sm" onClick={() => void copyShareUrls(displayNewShares)}>
                    <Copy className="h-4 w-4" />
                    {t('publicShareCopyAll')}
                  </Button>
                )}
              </div>
              <div className="max-h-64 min-w-0 space-y-2 overflow-y-auto">
                {displayNewShares.map((share) => renderShareCard(share))}
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
          {!hasResults && actionablePaths.length > 0 && (
            <Button onClick={handlePublish} disabled={isPublishing || isChecking || fileCount === 0} className="w-full sm:w-auto">
              {isPublishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe2 className="h-4 w-4" />}
              {isUpdatingSecurityMode
                ? t('publicShareUpdate')
                : existingShares.length > 0
                  ? t('publicSharePublishRemaining')
                  : t('publicSharePublish')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
