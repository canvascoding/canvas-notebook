'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, ChevronLeft, ChevronRight, Download, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { InertMarkdownPreview } from '@/app/components/shared/InertMarkdownPreview';
import { formatEmailAttachmentSize } from '@/app/lib/email/attachment-types';
import { emailAttachmentPreviewURL, type EmailAttachmentPreviewItem, type EmailAttachmentPreviewResource } from '@/app/lib/email/attachment-preview';

const PdfViewer = dynamic(() => import('@/app/components/editor/PdfViewer').then(module => module.PdfViewer), { ssr: false });
const OfficeViewer = dynamic(() => import('@/app/components/editor/OfficeEditor'), { ssr: false });

function AttachmentImagePreview({ url, name }: { url: string; name: string }) {
  const t = useTranslations('emailAttachmentPreview');
  const [failed, setFailed] = useState(false);
  return <div className="flex h-full min-h-0 items-center justify-center p-3">
    {failed ? <p role="alert" className="text-center text-sm text-muted-foreground">{t('errors.failed')}</p>
      // eslint-disable-next-line @next/next/no-img-element
      : <img src={url} alt={name} className="max-h-full max-w-full object-contain" onError={() => setFailed(true)} />}
  </div>;
}

export function EmailAttachmentPreviewDialog({ item, resource, error, loading, index, count, onPrevious, onNext, onClose }: {
  item: EmailAttachmentPreviewItem; resource: EmailAttachmentPreviewResource | null; error: string | null; loading: boolean;
  index: number; count: number; onPrevious(): void; onNext(): void; onClose(): void;
}) {
  const t = useTranslations('emailAttachmentPreview');
  const downloadURL = resource?.objectUrl || (item.source?.kind === 'workspace' && item.source.asPdf ? null : emailAttachmentPreviewURL(item));
  const canDownload = Boolean(downloadURL && !['forbidden', 'changed', 'unavailable'].includes(error || ''));
  const size = resource?.size ?? item.size;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent data-testid="email-attachment-preview" layout="viewport" showCloseButton={false}
      className="flex h-full min-w-0 flex-col gap-0 overflow-hidden p-0 sm:h-[90dvh] sm:max-h-[60rem] sm:max-w-5xl"
      onEscapeKeyDown={event => { event.stopPropagation(); }}>
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-2 sm:px-4">
        <div className="min-w-0 flex-1"><DialogTitle className="truncate text-sm" title={item.name}>{item.name}</DialogTitle>
          <DialogDescription className="truncate text-xs">{[item.mimeType, size === undefined ? null : formatEmailAttachmentSize(size), count > 1 ? `${index + 1} / ${count}` : null].filter(Boolean).join(' · ')}</DialogDescription></div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('download')} disabled={!canDownload} asChild={canDownload}>
          {canDownload ? <a href={downloadURL!} download={item.name}><Download /></a> : <Download />}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X /></Button>
      </div>
      {count > 1 && <div className="flex shrink-0 items-center justify-between border-b px-3 py-1">
        <Button data-testid="email-attachment-preview-previous" type="button" variant="ghost" size="sm" onClick={onPrevious}><ChevronLeft />{t('previous')}</Button>
        <span className="text-xs tabular-nums text-muted-foreground">{index + 1} / {count}</span>
        <Button data-testid="email-attachment-preview-next" type="button" variant="ghost" size="sm" onClick={onNext}>{t('next')}<ChevronRight /></Button>
      </div>}
      <div data-testid="email-attachment-preview-content" className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-background">
        {loading && <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin" />{t('loading')}</div>}
        {error && <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"><AlertCircle className="size-6 text-muted-foreground" /><p className="max-w-md text-sm">{t(`errors.${error}`)}</p></div>}
        {!loading && !error && resource?.kind === 'image' && <AttachmentImagePreview key={resource.objectUrl} url={resource.objectUrl} name={item.name} />}
        {!loading && !error && resource?.kind === 'pdf' && <PdfViewer key={resource.objectUrl} path={item.name} sourceUrl={resource.objectUrl} sourceData={resource.data} />}
        {!loading && !error && resource?.kind === 'office' && <OfficeViewer key={resource.objectUrl} path={item.name} extension={item.name.split('.').pop()?.toLowerCase() || ''} readOnly sourceUrl={resource.objectUrl} sourceData={resource.data} />}
        {!loading && !error && resource?.kind === 'markdown' && <div className="p-4 sm:p-6"><InertMarkdownPreview content={resource.text || ''} imageLabel={t('blockedImage')} linkLabel={t('inertLink')} tableLabel={t('table')} />{resource.truncated && <p className="mt-4 text-xs text-muted-foreground">{t('truncated')}</p>}</div>}
        {!loading && !error && resource?.kind === 'text' && <div className="p-4"><pre className="whitespace-pre-wrap break-words text-sm">{resource.text || t('empty')}</pre>{resource.truncated && <p className="mt-4 text-xs text-muted-foreground">{t('truncated')}</p>}</div>}
        {!loading && !error && resource?.kind === 'unsupported' && <div className="flex h-full items-center justify-center p-6 text-center"><p className="max-w-md text-sm text-muted-foreground">{t('unsupported')}</p></div>}
      </div>
    </DialogContent>
  </Dialog>;
}
