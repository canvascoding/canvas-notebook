'use client';

import { useEffect } from 'react';
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
import { EditorView } from '@codemirror/view';
import { useFileStore } from '@/app/store/file-store';
import { useTheme } from 'next-themes';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}

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

export function CodeEditor({ value, onChange, readOnly = false }: CodeEditorProps) {
  const { currentFile } = useFileStore();
  const { resolvedTheme } = useTheme();

  const extensions = currentFile
    ? [getLanguageExtension(currentFile.path), EditorView.lineWrapping]
    : [EditorView.lineWrapping];

  useEffect(() => {
    // Handle Cmd/Ctrl+S keyboard shortcut
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        // The parent FileEditor component will handle the actual save
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="h-full w-full">
      <CodeMirror
        value={value}
        height="100%"
        theme={resolvedTheme === 'light' ? 'light' : 'dark'}
        extensions={extensions}
        onChange={onChange}
        editable={!readOnly}
        basicSetup={{
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
        }}
        style={{
          fontSize: '14px',
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
          height: '100%',
        }}
        className="codemirror-wrapper"
      />
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
