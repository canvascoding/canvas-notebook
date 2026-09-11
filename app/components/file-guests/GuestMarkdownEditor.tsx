'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCollaborationDocument, type CollaborationDocument } from '@/app/lib/collaboration/client';
import { canRenderCollaborationDocument } from '@/app/lib/collaboration/editor-presentation';
import { isRichTextCollaborationRepresentation, type CollaborationSessionResponse } from '@/app/lib/collaboration/types';
import { MarkdownModeBar, MarkdownSaveState, useLiveMarkdown, type MarkdownDocumentMode } from '@/app/components/editor/MarkdownDocumentModes';
import { RichMarkdownEditor, useMobileKeyboardActive, useVisualViewportBottomOffset } from '@/app/components/editor/MarkdownEditor';
import { MarkdownEditorAccessContext, type MarkdownEditorAccess } from '@/app/components/editor/MarkdownEditorAccess';
import { resolvePublicMarkdownImageWorkspacePath } from '@/app/lib/public-sharing/public-markdown-images';
import { fileGuestApi } from '@/app/lib/file-guests/types';

function imageUrl(source: string, path: string, invitationId: string, assets: string[], workspaceId?: string) {
  const workspacePath = resolvePublicMarkdownImageWorkspacePath(path, source, workspaceId);
  if (workspacePath && assets.includes(workspacePath)) return `${fileGuestApi(invitationId)}/assets/${workspacePath.split('/').map(encodeURIComponent).join('/')}`;
  return /^https:\/\//iu.test(source) ? source : null;
}

function GuestRichEditor({ collaboration, editable, path, invitationId, assets, value, onSourceMode }: {
  collaboration: CollaborationDocument; editable: boolean; path: string; invitationId: string; assets: string[];
  value: string; onSourceMode: () => void;
}) {
  const workspaceId = collaboration.session?.guestAccess?.workspaceId;
  const access = useMemo<MarkdownEditorAccess>(() => ({
    workspace: false,
    resolveImage: (source) => imageUrl(source, path, invitationId, assets, workspaceId),
  }), [path, invitationId, assets, workspaceId]);
  const isMobileKeyboardActive = useMobileKeyboardActive();
  return <MarkdownEditorAccessContext.Provider value={access}>
    <RichMarkdownEditor value={value} filePath={path} readOnly={!editable}
      collaborationEnabled collaborationDocument={collaboration}
      isMobileKeyboardActive={isMobileKeyboardActive} onSourceMode={onSourceMode} />
  </MarkdownEditorAccessContext.Provider>;
}

function GuestSourceEditor({ collaboration, editable, value }: { collaboration: CollaborationDocument; editable: boolean; value: string }) {
  const t = useTranslations('notebook.editorModes');
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping,
    yCollab(collaboration.doc.getText('content'), collaboration.provider?.awareness)], [collaboration.doc, collaboration.provider]);
  return <CodeMirror value={value} height="60vh" editable={editable} readOnly={!editable} aria-label={t('guestMarkdownSource')}
    basicSetup={{ history: false }} extensions={extensions} />;
}

export function GuestMarkdownEditor({ session, path, fileName, initialMarkdown, assets, onReload }: {
  session: CollaborationSessionResponse; path: string; fileName: string; initialMarkdown: string; assets: string[]; onReload: () => void;
}) {
  const t = useTranslations('notebook.editorModes');
  useVisualViewportBottomOffset();
  const [wide, setWide] = useState(false);
  const guest = session.guestAccess!;
  const collaboration = useCollaborationDocument({ enabled: true, workspaceId: guest.workspaceId, path,
    representation: isRichTextCollaborationRepresentation(session.representation) ? session.representation : 'plain_text', session });
  const live = useLiveMarkdown(collaboration, initialMarkdown);
  const [mode, setMode] = useState<MarkdownDocumentMode>(session.permission === 'write' ? 'rich' : 'read');
  const denied = collaboration?.connection === 'denied';
  const editable = session.permission === 'write' && collaboration?.session?.permission === 'write' && !denied && collaboration.durability !== 'degraded';
  const download = () => {
    const url = URL.createObjectURL(new Blob([live.content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="relative overflow-hidden rounded-xl border bg-background shadow-sm" aria-label={t('guestDocument')}
    data-document-width={wide ? 'wide' : 'page'} data-editor-layout="document" data-editor-mode={mode}>
    <MarkdownModeBar mode={mode} onChange={setMode} readOnly={!editable} wide={wide} onWideChange={setWide}
      actions={<Button size="sm" variant="ghost" onClick={download} disabled={!live.available}>
        <Download className="mr-1.5 size-4" />{t('guestDownloadCopy')}
      </Button>} />
    <MarkdownSaveState collaboration={collaboration} content={live.content} available={live.available} filePath={path} onReload={onReload} />
    <div className="markdown-editor-content h-[65dvh] min-h-[20rem] overflow-hidden">
    {!collaboration?.ready || !canRenderCollaborationDocument(collaboration, live.available) ? <p className="p-10 text-center text-muted-foreground">{t(collaboration?.ready ? 'guestDocumentUnavailable' : 'guestOpeningDocument')}</p>
      : mode === 'source' && isRichTextCollaborationRepresentation(session.representation)
        ? live.available
          ? <div className="flex h-full min-h-0 flex-col"><p className="shrink-0 border-b px-5 py-2 text-xs text-muted-foreground">{t('liveSource')}</p><pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-5 text-sm">{live.content}</pre></div>
          : <p className="p-10 text-center text-muted-foreground">{t('sourceUnavailable')}</p>
        : isRichTextCollaborationRepresentation(session.representation)
          ? <GuestRichEditor collaboration={collaboration} editable={editable && mode === 'rich'} path={path} invitationId={guest.invitationId} assets={assets}
            value={live.content} onSourceMode={() => setMode('source')} />
          : mode !== 'read'
            ? <GuestSourceEditor collaboration={collaboration} editable={editable} value={live.content} />
            : <div className="canvas-document-reading h-full overflow-auto prose max-w-none break-words p-5 md:p-10"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
              img: ({ src, alt }) => {
                const url = imageUrl(typeof src === 'string' ? src : '', path, guest.invitationId, assets, guest.workspaceId);
                // eslint-disable-next-line @next/next/no-img-element
                return url ? <img src={url} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" /> : <span>{t('guestImageUnavailable', { name: alt || t('guestImage') })}</span>;
              },
              a: ({ href, children }) => /^https?:\/\//iu.test(href || '') ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span title={t('guestPrivateFiles')}>{children}</span>,
            }}>{live.content}</ReactMarkdown></div>}
    </div>
    <footer className="border-t px-5 py-3 text-xs text-muted-foreground">{t('guestAccessScope')}</footer>
  </section>;
}
