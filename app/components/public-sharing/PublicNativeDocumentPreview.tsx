'use client';

import { useMemo } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';

import type { NativeCollaborationContent } from '@/app/lib/collaboration/document-snapshot';
import { richMarkdownCodecExtensions } from '@/app/lib/markdown/rich-markdown-codec';

function NativeRichContent({ document, fileName }: { document: JSONContent; fileName: string }) {
  const extensions = useMemo(() => richMarkdownCodecExtensions(), []);
  const editor = useEditor({
    extensions,
    content: document,
    contentType: 'json',
    editable: false,
    autofocus: false,
    immediatelyRender: false,
    enableInputRules: false,
    enablePasteRules: false,
    editorProps: { attributes: { role: 'document', 'aria-label': fileName, style: 'min-height:0;padding:0' } },
  }, [document]);
  return <div className="tiptap-editor-shell" data-public-native-rich="true">
    {editor ? <EditorContent editor={editor} /> : <p role="status">Loading document…</p>}
  </div>;
}

/** No collaboration session, Markdown round trip or editing controls. */
export function PublicNativeDocumentPreview({ content, fileName }: { content: NativeCollaborationContent; fileName: string }) {
  return <div className="h-full overflow-auto" data-public-native-document="true">
    <article className="mx-auto max-w-5xl p-5 text-base leading-relaxed md:px-12">
      {content.kind === 'plain_text' ? <pre className="whitespace-pre-wrap break-words font-sans">{content.text}</pre> : <>
        {content.frontmatter ? <pre className="mb-5 whitespace-pre-wrap break-words rounded-md border border-border p-3 text-sm">{content.frontmatter}</pre> : null}
        <NativeRichContent document={content.document} fileName={fileName} />
      </>}
    </article>
  </div>;
}
