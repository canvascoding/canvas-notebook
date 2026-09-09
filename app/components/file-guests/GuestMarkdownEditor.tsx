'use client';

import { useEffect, useMemo, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '@/app/lib/collaboration/rich-editor-extensions';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download, Eye, Pencil, Code2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCollaborationDocument, type CollaborationDocument } from '@/app/lib/collaboration/client';
import { isRichTextCollaborationRepresentation, type CollaborationSessionResponse } from '@/app/lib/collaboration/types';
import { useLiveMarkdown } from '@/app/components/editor/MarkdownDocumentModes';
import { richMarkdownCodecExtensions } from '@/app/lib/markdown/rich-markdown-codec';
import { CanvasImage } from '@/app/lib/markdown/core/image';
import { resolvePublicMarkdownImageWorkspacePath } from '@/app/lib/public-sharing/public-markdown-images';
import { fileGuestApi } from '@/app/lib/file-guests/types';

function imageUrl(source: string, path: string, invitationId: string, assets: string[], workspaceId?: string) {
  const workspacePath = resolvePublicMarkdownImageWorkspacePath(path, source, workspaceId);
  if (workspacePath && assets.includes(workspacePath)) return `${fileGuestApi(invitationId)}/assets/${workspacePath.split('/').map(encodeURIComponent).join('/')}`;
  return /^https:\/\//iu.test(source) ? source : null;
}

function GuestRichEditor({ collaboration, editable, path, invitationId, assets }: {
  collaboration: CollaborationDocument; editable: boolean; path: string; invitationId: string; assets: string[];
}) {
  const userName = collaboration.session?.user.name;
  const userColor = collaboration.session?.user.color;
  const workspaceId = collaboration.session?.guestAccess?.workspaceId;
  const representation = collaboration.session?.representation === 'tiptap_blocks' ? 'tiptap_blocks' : 'tiptap_xml';
  const extensions = useMemo(() => [
    ...richMarkdownCodecExtensions().map((extension) => {
      if (extension.name === 'starterKit') return extension.configure({ undoRedo: false });
      if (extension.name === 'uniqueID') return extension.configure({ filterTransaction: (transaction: Parameters<typeof isRemoteRichEditorTransaction>[0]) => !isRemoteRichEditorTransaction(transaction) });
      if (extension.name !== 'image') return extension;
      // Rewrite display URLs only. The shared Y.Doc retains the owner's paths.
      return CanvasImage.extend({ addNodeView() {
        return ({ node }) => {
          const dom = document.createElement('figure');
          const render = (attrs: Record<string, unknown>) => {
            dom.replaceChildren();
            const src = imageUrl(String(attrs.src || ''), path, invitationId, assets, workspaceId);
            if (!src) { dom.textContent = `Bild nicht freigegeben: ${String(attrs.alt || 'Bild')}`; return; }
            const image = document.createElement('img');
            image.src = src; image.alt = String(attrs.alt || ''); image.referrerPolicy = 'no-referrer'; image.loading = 'lazy';
            dom.append(image);
          };
          render(node.attrs);
          return { dom, update(updated) { if (updated.type !== node.type) return false; render(updated.attrs); return true; } };
        };
      } });
    }),
    ...createRichEditorCollaborationExtensions({ document: collaboration.doc, representation,
      awareness: collaboration.provider?.awareness ?? null, user: { name: userName ?? 'Gast', color: userColor ?? '#64748b' } }),
  ], [collaboration.doc, collaboration.provider, representation, userName, userColor, workspaceId, path, invitationId, assets]);
  const editor = useEditor({ extensions, editable, immediatelyRender: false,
    editorProps: { attributes: { class: 'tiptap canvas-document-editor min-h-[55vh] p-5 outline-none md:p-10', 'aria-label': 'Geteilte Markdown-Datei bearbeiten' } },
  }, [extensions]);
  useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);
  return <div>
    {editable && <div className="flex flex-wrap gap-1 border-b px-4 py-2" role="toolbar" aria-label="Textformatierung">
      <Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().toggleBold().run()}>Fett</Button>
      <Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().toggleItalic().run()}>Kursiv</Button>
      <Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>Überschrift</Button>
      <Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().toggleBulletList().run()}>Liste</Button>
      <Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().undo().run()}>Rückgängig</Button>
      <Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().redo().run()}>Wiederholen</Button>
    </div>}
    <EditorContent editor={editor} />
  </div>;
}

function GuestSourceEditor({ collaboration, editable, value }: { collaboration: CollaborationDocument; editable: boolean; value: string }) {
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping,
    yCollab(collaboration.doc.getText('content'), collaboration.provider?.awareness)], [collaboration.doc, collaboration.provider]);
  return <CodeMirror value={value} height="60vh" editable={editable} readOnly={!editable} aria-label="Markdown-Quelltext"
    basicSetup={{ history: false }} extensions={extensions} />;
}

export function GuestMarkdownEditor({ session, path, fileName, initialMarkdown, assets, onReload }: {
  session: CollaborationSessionResponse; path: string; fileName: string; initialMarkdown: string; assets: string[]; onReload: () => void;
}) {
  const guest = session.guestAccess!;
  const collaboration = useCollaborationDocument({ enabled: true, workspaceId: guest.workspaceId, path,
    representation: isRichTextCollaborationRepresentation(session.representation) ? session.representation : 'plain_text', session });
  const live = useLiveMarkdown(collaboration, initialMarkdown);
  const [mode, setMode] = useState<'read' | 'edit' | 'source'>(session.permission === 'write' ? 'edit' : 'read');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const denied = collaboration?.connection === 'denied';
  const editable = session.permission === 'write' && collaboration?.session?.permission === 'write' && !denied && collaboration.durability !== 'degraded';
  const status = denied ? 'Zugriff entzogen' : !collaboration?.ready ? 'Verbindung wird aufgebaut …'
    : collaboration.connection === 'offline' || collaboration.connection === 'reconnecting' ? 'Offline · Änderungen bleiben lokal'
      : collaboration.durability === 'checkpointed_file' ? 'Gespeichert'
        : collaboration.durability === 'degraded' ? 'Speichern fehlgeschlagen · lokale Kopie sichern'
          : collaboration.clientState.unsyncedChanges > 0 ? 'Änderungen werden synchronisiert …' : 'Verbunden';
  const download = () => {
    const url = URL.createObjectURL(new Blob([live.content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const save = async () => {
    if (!collaboration || saving) return;
    setSaving(true); setError(null);
    try { await collaboration.requestCheckpoint(); } catch { setError('Speichern ist momentan nicht möglich. Deine lokale Kopie bleibt erhalten.'); }
    finally { setSaving(false); }
  };
  return <section className="overflow-hidden rounded-xl border bg-background shadow-sm" aria-label="Geteilte Datei">
    <div className="flex flex-wrap items-center gap-2 border-b p-3">
      <div className="flex gap-1" role="group" aria-label="Ansicht">
        <Button size="sm" variant={mode === 'read' ? 'secondary' : 'ghost'} aria-pressed={mode === 'read'} onClick={() => setMode('read')}><Eye className="mr-1.5 size-4" />Lesen</Button>
        {session.permission === 'write' && <Button size="sm" disabled={!editable} variant={mode === 'edit' ? 'secondary' : 'ghost'} aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}><Pencil className="mr-1.5 size-4" />Bearbeiten</Button>}
        <Button size="sm" variant={mode === 'source' ? 'secondary' : 'ghost'} aria-pressed={mode === 'source'} onClick={() => setMode('source')}><Code2 className="mr-1.5 size-4" />Quelltext</Button>
      </div>
      <span className="ml-auto text-xs text-muted-foreground" role="status" aria-live="polite">{status}</span>
      <Button size="sm" variant="ghost" onClick={download} disabled={!live.available}><Download className="mr-1.5 size-4" />Kopie</Button>
      {session.permission === 'write' && <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving || !editable || collaboration?.connection !== 'live'}><Save className="mr-1.5 size-4" />Speichern</Button>}
    </div>
    {(denied || error || collaboration?.error) && <div className="border-b bg-muted p-4 text-sm" role="alert">
      {collaboration?.error || (denied ? 'Diese Sitzung hat keinen Zugriff mehr. Du kannst deinen lokalen Stand als Kopie herunterladen. Erneutes Öffnen prüft die aktuellen Rechte.' : error)}
      <Button className="ml-2" variant="outline" size="sm" onClick={onReload}>Erneut öffnen</Button>
    </div>}
    {!collaboration?.ready || !live.available ? <p className="p-10 text-center text-muted-foreground">{live.available ? 'Dokument wird synchronisiert …' : 'Der Dokumentstand konnte nicht dargestellt werden.'}</p>
      : mode === 'source' && isRichTextCollaborationRepresentation(session.representation)
        ? <><p className="border-b px-5 py-2 text-xs text-muted-foreground">Der Quelltext zeigt den aktuellen Stand. Bearbeite dieses Dokument in der Textansicht.</p><pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words p-5 text-sm">{live.content}</pre></>
        : isRichTextCollaborationRepresentation(session.representation)
          ? <GuestRichEditor collaboration={collaboration} editable={editable && mode === 'edit'} path={path} invitationId={guest.invitationId} assets={assets} />
          : mode !== 'read'
            ? <GuestSourceEditor collaboration={collaboration} editable={editable} value={live.content} />
            : <div className="canvas-document-reading prose max-w-none break-words p-5 md:p-10"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
              img: ({ src, alt }) => {
                const url = imageUrl(typeof src === 'string' ? src : '', path, guest.invitationId, assets, guest.workspaceId);
                // eslint-disable-next-line @next/next/no-img-element
                return url ? <img src={url} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" /> : <span>Bild nicht freigegeben: {alt || 'Bild'}</span>;
              },
              a: ({ href, children }) => /^https?:\/\//iu.test(href || '') ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span title="Andere Workspace-Dateien sind nicht freigegeben.">{children}</span>,
            }}>{live.content}</ReactMarkdown></div>}
    <footer className="border-t px-5 py-3 text-xs text-muted-foreground">Nur diese Datei und die ausdrücklich freigegebenen Bilder sind zugänglich. Wiki-Verknüpfungen und andere Workspace-Dateien bleiben privat.</footer>
  </section>;
}
