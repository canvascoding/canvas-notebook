'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { xml } from '@codemirror/lang-xml';
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { Extension as CodeMirrorExtension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { toast } from 'sonner';
import { WorkspaceDocumentPreviewDialog } from '@/app/components/shared/WorkspaceDocumentPreviewDialog';
import { useFileStore } from '@/app/store/file-store';
import { useTheme } from '@/app/components/ThemeProvider';
import { getTextEditorPerformanceProfile } from '@/app/lib/editor/text-editor-guards';
import {
  findObsidianWikiCompletionContext,
} from '@/app/lib/markdown/obsidian-link-resolver';
import { parseObsidianWikiLinks } from '@/app/lib/markdown/obsidian-flavored-markdown';
import {
  getWorkspaceWikiCompletionItems,
  loadWorkspaceLinkIndex,
  loadWorkspaceDocumentReference,
} from '@/app/lib/markdown/workspace-link-index-client';
import type { WorkspaceDocumentReference } from '@/app/lib/markdown/workspace-document-preview';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import type { WorkspaceMarkdownLocation } from '@/app/lib/markdown/workspace-markdown-navigation';
import { useTranslations } from 'next-intl';
import { yCollab } from 'y-codemirror.next';
import {
  useCollaborationDocument,
  type CollaborationDocument,
} from '@/app/lib/collaboration/client';
import { getCodeEditorLifecycleKey } from '@/app/lib/collaboration/code-editor-lifecycle';
import type { CollaborationSessionResponse } from '@/app/lib/collaboration/types';

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  path?: string;
  markdownNavigationTarget?: WorkspaceMarkdownLocation | null;
  collaborationEnabled?: boolean;
  collaborationSession?: CollaborationSessionResponse | null;
  collaborationDocument?: CollaborationDocument | null;
  onCollaborationChange?: (document: CollaborationDocument | null) => void;
}

const CODE_MIRROR_BASIC_SETUP = {
  lineNumbers: true,
  highlightActiveLineGutter: true,
  highlightSpecialChars: true,
  foldGutter: true,
  drawSelection: true,
  dropCursor: true,
  allowMultipleSelections: true,
  indentOnInput: true,
  syntaxHighlighting: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: true,
  rectangularSelection: true,
  crosshairCursor: true,
  highlightActiveLine: true,
  highlightSelectionMatches: true,
  closeBracketsKeymap: true,
  searchKeymap: true,
  foldKeymap: true,
  completionKeymap: true,
  lintKeymap: true,
};

const LIGHTWEIGHT_CODE_MIRROR_BASIC_SETUP = {
  ...CODE_MIRROR_BASIC_SETUP,
  highlightActiveLineGutter: false,
  highlightSpecialChars: false,
  foldGutter: false,
  dropCursor: false,
  autocompletion: false,
  rectangularSelection: false,
  crosshairCursor: false,
  highlightActiveLine: false,
  highlightSelectionMatches: false,
  closeBracketsKeymap: false,
  completionKeymap: false,
  lintKeymap: false,
};

const CODE_MIRROR_STYLE: CSSProperties = {
  fontSize: '14px',
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
  height: '100%',
};

// Get CodeMirror language extension based on file path
function getLanguageExtension(path: string) {
  const ext = path.split('.').pop()?.toLowerCase();

  switch (ext) {
    // JavaScript/TypeScript
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: true });
    case 'ts':
    case 'tsx':
      return javascript({ jsx: true, typescript: true });

    // Python
    case 'py':
      return python();

    // Web
    case 'html':
    case 'htm':
      return html();
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return css();

    // Data formats
    case 'json':
      return json();
    case 'xml':
      return xml();

    // Markdown
    case 'md':
    case 'mdx':
    case 'markdown':
      return markdown();

    // Programming languages
    case 'php':
      return php();
    case 'sql':
      return sql();
    case 'rs':
      return rust();
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
    case 'h':
    case 'c':
      return cpp();
    case 'java':
      return java();

    default:
      return [];
  }
}

function isMarkdownPath(path: string | undefined): boolean {
  const extension = path?.split('.').pop()?.toLowerCase();
  return extension === 'md' || extension === 'mdx' || extension === 'markdown';
}

function createObsidianWikiCompletionSource(workspaceId: string, sourcePath?: string) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const completionContext = findObsidianWikiCompletionContext(
      context.state.doc.toString(),
      context.pos,
    );
    if (!completionContext) return null;

    try {
      const index = await loadWorkspaceLinkIndex(workspaceId);
      if (context.aborted) return null;

      return {
        from: completionContext.from,
        to: completionContext.to,
        options: getWorkspaceWikiCompletionItems(index, completionContext, sourcePath, 200)
          .map((item) => ({
            label: item.target,
            displayLabel: item.displayLabel,
            detail: item.detail,
            type: item.kind === 'document' ? 'text' : item.kind === 'heading' ? 'keyword' : 'variable',
            apply: `${item.target}]]`,
          })),
        validFor: /^[^\]|\r\n]*$/,
      };
    } catch (error) {
      if (context.aborted) return null;
      console.warn('[CodeEditor] Failed to load Obsidian wiki-link suggestions:', error);
      return null;
    }
  };
}

function createObsidianWikiPreviewExtension(
  workspaceId: string,
  sourcePath: string,
  onPreview: (reference: WorkspaceDocumentReference) => void,
  labels: {
    ambiguous: (candidates: string) => string;
    failed: string;
    missing: (target: string) => string;
  },
): CodeMirrorExtension {
  return EditorView.domEventHandlers({
    click(event, view) {
      if (!(event.metaKey || event.ctrlKey)) return false;
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return false;
      const markdown = view.state.doc.toString();
      const wikiLink = parseObsidianWikiLinks(markdown).find((link) => (
        link.start <= position && position <= link.end
      ));
      if (!wikiLink) return false;

      event.preventDefault();
      event.stopPropagation();
      void loadWorkspaceDocumentReference(workspaceId, wikiLink.target, sourcePath)
        .then((lookup) => {
          if (lookup.reference) {
            onPreview(lookup.reference);
            return;
          }
          toast.error(lookup.resolution?.status === 'ambiguous'
            ? labels.ambiguous(lookup.resolution.candidates.join(', '))
            : labels.missing(lookup.resolution?.target.path || wikiLink.target));
        })
        .catch((error) => {
          toast.error(error instanceof Error ? error.message : labels.failed);
        });
      return true;
    },
  });
}

function normalizeHeadingLabel(value: string): string {
  return value
    .replace(/\\([\\`*_[\]{}()#+.!<>-])/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim()
    .toLocaleLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMarkdownNavigationOffset(
  markdown: string,
  target: WorkspaceMarkdownLocation,
): number | null {
  const lines = markdown.split('\n');
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (target.blockId) {
      const blockMatch = line.match(new RegExp(`(?:^|[ \\t])\\^${escapeRegex(target.blockId)}[ \\t]*$`, 'i'));
      if (blockMatch) return offset + Math.max(0, blockMatch.index ?? 0);
    }

    if (target.heading) {
      const atxMatch = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/);
      if (atxMatch && normalizeHeadingLabel(atxMatch[1]) === normalizeHeadingLabel(target.heading)) {
        return offset;
      }
      const underline = lines[index + 1];
      if (
        line.trim()
        && underline
        && /^ {0,3}(?:=+|-+)[ \t]*$/.test(underline)
        && normalizeHeadingLabel(line) === normalizeHeadingLabel(target.heading)
      ) {
        return offset;
      }
    }
    offset += line.length + 1;
  }
  return null;
}

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  path,
  markdownNavigationTarget,
  collaborationEnabled,
  collaborationSession,
  collaborationDocument,
  onCollaborationChange,
}: CodeEditorProps) {
  const t = useTranslations('notebook');
  const { currentFile } = useFileStore();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const { resolvedTheme } = useTheme();
  const languagePath = path || currentFile?.path;
  const extension = languagePath?.split('.').pop()?.toLowerCase();
  const supportsCollaboration = extension === 'md' || extension === 'markdown' || extension === 'txt';
  const shouldCollaborate = collaborationEnabled ?? Boolean(currentFile?.collaboration?.crdtCapable && supportsCollaboration);
  const internalCollaboration = useCollaborationDocument({
    enabled: shouldCollaborate && !collaborationDocument,
    workspaceId: activeWorkspaceId,
    path: languagePath,
    representation: 'plain_text',
    session: collaborationSession,
  });
  const collaboration = collaborationDocument ?? internalCollaboration;
  const collaborationText = collaboration?.doc.getText('content') ?? null;
  const collaborationAwareness = collaboration?.provider?.awareness ?? null;
  const setCollaborationComposition = collaboration?.setComposition ?? null;
  const collaborationBindingReady = Boolean(
    collaborationText
    && collaborationAwareness
    && setCollaborationComposition
  );
  const codeEditorLifecycleKey = getCodeEditorLifecycleKey({
    workspaceId: activeWorkspaceId,
    path: languagePath,
    collaborationRequested: shouldCollaborate,
    collaborationRegistryKey: collaboration?.registryKey ?? null,
    collaborationBindingReady,
  });
  const collaborationReadOnly = shouldCollaborate && (
    !collaboration?.session
    || collaboration.session.permission !== 'write'
    || collaboration.status === 'degraded'
  );
  const effectiveReadOnly = readOnly || collaborationReadOnly;
  const performanceProfile = useMemo(() => getTextEditorPerformanceProfile(value), [value]);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [documentPreview, setDocumentPreview] = useState<WorkspaceDocumentReference | null>(null);
  const onChangeRef = useRef(onChange);

  // `@uiw/react-codemirror` reconfigures its extensions whenever its onChange
  // prop changes. Source-mode Markdown recreates that callback as its draft is
  // updated, which can tear down yCollab while Yjs is applying an update.
  // Keep the callback supplied to CodeMirror stable for the lifetime of this
  // editor and forward to the latest parent handler instead.
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onCollaborationChange?.(collaboration);
    return () => onCollaborationChange?.(null);
  }, [collaboration, onCollaborationChange]);

  const handleChange = useCallback((nextValue: string) => {
    onChangeRef.current(nextValue);
  }, []);

  const collaborationExtensions = useMemo<CodeMirrorExtension[]>(() => {
    if (!collaborationText || !collaborationAwareness || !setCollaborationComposition) return [];
    return [
      yCollab(collaborationText, collaborationAwareness),
      EditorView.domEventHandlers({
        compositionstart(_event, view) {
          const selection = view.state.selection.main;
          setCollaborationComposition({ textName: 'content', from: selection.from, to: selection.to });
          return false;
        },
        compositionend() {
          setCollaborationComposition(null);
          return false;
        },
        blur() {
          setCollaborationComposition(null);
          return false;
        },
      }),
    ];
  }, [collaborationAwareness, collaborationText, setCollaborationComposition]);

  const extensions = useMemo(() => {
    const nextExtensions: CodeMirrorExtension[] = [];
    if (languagePath && !performanceProfile.disableLanguageExtension) {
      nextExtensions.push(getLanguageExtension(languagePath));
    }
    if (!performanceProfile.disableLineWrapping) {
      nextExtensions.push(EditorView.lineWrapping);
    }
    if (
      activeWorkspaceId
      && isMarkdownPath(languagePath)
      && !performanceProfile.disableLanguageExtension
    ) {
      if (!effectiveReadOnly) {
        nextExtensions.push(autocompletion({
          override: [createObsidianWikiCompletionSource(activeWorkspaceId, languagePath)],
        }));
      }
      if (languagePath) {
        nextExtensions.push(createObsidianWikiPreviewExtension(
          activeWorkspaceId,
          languagePath,
          setDocumentPreview,
          {
            ambiguous: (candidates) => t('markdownDocumentLinkAmbiguous', { candidates }),
            failed: t('markdownEditorLinkOpenError'),
            missing: (target) => t('markdownDocumentLinkMissing', { target }),
          },
        ));
      }
    }
    nextExtensions.push(...collaborationExtensions);
    return nextExtensions;
  }, [
    activeWorkspaceId,
    languagePath,
    performanceProfile.disableLanguageExtension,
    performanceProfile.disableLineWrapping,
    effectiveReadOnly,
    collaborationExtensions,
    t,
  ]);

  useEffect(() => {
    if (effectiveReadOnly) return;

    // Handle Cmd/Ctrl+S keyboard shortcut
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        // The parent FileEditor component will handle the actual save
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [effectiveReadOnly]);

  useEffect(() => {
    if (!editorView || !markdownNavigationTarget) return;
    const offset = findMarkdownNavigationOffset(editorView.state.doc.toString(), markdownNavigationTarget);
    if (offset === null) return;
    editorView.dispatch({
      selection: { anchor: offset },
      effects: EditorView.scrollIntoView(offset, { y: 'center' }),
    });
    editorView.focus();
  }, [editorView, markdownNavigationTarget]);

  if (shouldCollaborate && !collaboration?.ready) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background p-6 text-center">
        <p className="text-sm text-muted-foreground" role="status">
          {collaboration?.error || t('collaboration.connecting')}
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <CodeMirror
        key={codeEditorLifecycleKey}
        value={collaborationText?.toString() ?? value}
        height="100%"
        theme={resolvedTheme === 'light' ? 'light' : 'dark'}
        extensions={extensions}
        onChange={handleChange}
        onCreateEditor={(view) => setEditorView(view)}
        editable={!effectiveReadOnly}
        basicSetup={performanceProfile.disableLanguageExtension ? LIGHTWEIGHT_CODE_MIRROR_BASIC_SETUP : CODE_MIRROR_BASIC_SETUP}
        style={CODE_MIRROR_STYLE}
        className="codemirror-wrapper"
      />
      <WorkspaceDocumentPreviewDialog
        open={documentPreview !== null}
        reference={documentPreview}
        onOpenChange={(open) => {
          if (!open) setDocumentPreview(null);
        }}
      />
      {shouldCollaborate && (
        <div className="pointer-events-none absolute right-3 top-2 z-10 rounded bg-background/85 px-2 py-1 text-[10px] text-muted-foreground shadow-sm" role="status">
          {collaboration?.status === 'degraded'
            ? collaboration.error || t('collaboration.degraded')
            : collaboration?.status === 'saved' || collaboration?.status === 'live'
              ? t('collaboration.live')
              : collaboration?.status === 'persisting'
                ? t('collaboration.persisting')
                : collaboration?.status === 'offline' || collaboration?.status === 'reconnecting'
                  ? t('collaboration.offline')
              : collaboration?.status === 'read_only'
                ? t('collaboration.readOnly')
                : collaboration?.status || t('collaboration.connecting')}
        </div>
      )}
      <style jsx global>{`
        .codemirror-wrapper {
          height: 100%;
        }
        .codemirror-wrapper .cm-editor {
          height: 100%;
        }
        .codemirror-wrapper .cm-scroller {
          overflow-y: auto;
          overflow-x: hidden;
          font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace !important;
        }
        .codemirror-wrapper .cm-content {
          padding: 16px 0;
        }
        .codemirror-wrapper .cm-gutters {
          background-color: var(--muted);
          color: var(--muted-foreground);
          border-right: 1px solid var(--border);
        }
        .codemirror-wrapper .cm-activeLineGutter {
          background-color: color-mix(in oklab, var(--accent) 55%, transparent);
        }
        .codemirror-wrapper .cm-activeLine {
          background-color: color-mix(in oklab, var(--accent) 36%, transparent);
        }
        .codemirror-wrapper .cm-selectionBackground {
          background-color: color-mix(in oklab, var(--primary) 30%, transparent) !important;
        }
        .codemirror-wrapper .cm-cursor {
          border-left-color: var(--foreground);
        }
      `}</style>
    </div>
  );
}
