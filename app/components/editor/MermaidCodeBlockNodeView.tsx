'use client';

import { useState } from 'react';
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Code2, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { ClipboardCopyButton } from '@/app/components/shared/ClipboardCopyButton';
import { codeBlockClipboardContent } from '@/app/lib/clipboard/browser';
import { Button } from '@/components/ui/button';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';

export function MermaidCodeBlockNodeView({ node }: NodeViewProps) {
  const t = useTranslations('notebook');
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
  const isMermaid = language.toLowerCase() === 'mermaid';
  const [editingLanguage, setEditingLanguage] = useState<string | null>(null);
  const isEditing = !isMermaid || editingLanguage === language;
  const toggleLabel = t(isEditing ? 'mermaidShowPreview' : 'mermaidShowCode');

  return (
    <NodeViewWrapper
      as="div"
      className={`${isMermaid && !isEditing ? 'tiptap-mermaid-node' : 'tiptap-code-block'} group relative min-w-0`}
      data-mermaid-mode={isMermaid ? isEditing ? 'code' : 'preview' : undefined}
    >
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1" contentEditable={false}>
        <ClipboardCopyButton
          content={codeBlockClipboardContent(node.textContent)}
          menuSide="bottom"
          testId="markdown-editor-code-block-copy"
          buttonClassName={isMermaid ? undefined : 'sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100'}
        />
        {isMermaid && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={toggleLabel}
            title={toggleLabel}
            data-testid="markdown-editor-mermaid-toggle"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              setEditingLanguage(isEditing ? null : language);
            }}
          >
            {isEditing ? <Play aria-hidden="true" /> : <Code2 aria-hidden="true" />}
          </Button>
        )}
      </div>
      {/* Keep ProseMirror's content DOM mounted across preview switches. */}
      <pre style={isEditing ? undefined : { display: 'none' }}>
        <NodeViewContent spellCheck={false} className={isMermaid ? 'pr-24' : 'pr-12'} />
      </pre>
      {isMermaid && !isEditing && (
        <div
          className="pt-8"
          contentEditable={false}
          role="button"
          tabIndex={0}
          aria-label={t('mermaidShowCode')}
          onClick={() => setEditingLanguage(language)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setEditingLanguage(language);
            }
          }}
        >
          <MermaidDiagram code={node.textContent} interactive={false} />
        </div>
      )}
    </NodeViewWrapper>
  );
}
