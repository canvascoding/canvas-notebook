'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Code2, RefreshCw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  Excalidraw,
  Footer,
  MainMenu,
  WelcomeScreen,
  serializeAsJSON,
} from '@excalidraw/excalidraw';
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/app/components/ThemeProvider';
import { EXCALIDRAW_FILE_SOURCE, createEmptyExcalidrawFileContent } from '@/app/lib/excalidraw-file';
import { CodeEditor } from './CodeEditor';

interface ExcalidrawEditorProps {
  path: string;
  value: string;
  onChange: (content: string) => void;
}

interface ExcalidrawSession {
  initialData: ExcalidrawInitialDataState | null;
  invalid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseExcalidrawContent(content: string): ExcalidrawSession {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      invalid: false,
      initialData: {
        elements: [],
        appState: {
          viewBackgroundColor: '#ffffff',
        },
        files: {},
        scrollToContent: true,
      },
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return { invalid: true, initialData: null };
    }

    return {
      invalid: false,
      initialData: {
        elements: Array.isArray(parsed.elements) ? parsed.elements as ExcalidrawInitialDataState['elements'] : [],
        appState: isRecord(parsed.appState) ? parsed.appState as ExcalidrawInitialDataState['appState'] : {},
        files: isRecord(parsed.files) ? parsed.files as ExcalidrawInitialDataState['files'] : {},
        scrollToContent: true,
      },
    };
  } catch {
    return { invalid: true, initialData: null };
  }
}

function stripHostControlledAppState(appState: AppState): Partial<AppState> {
  const {
    theme: _theme,
    width: _width,
    height: _height,
    offsetLeft: _offsetLeft,
    offsetTop: _offsetTop,
    collaborators: _collaborators,
    ...exportableAppState
  } = appState;
  return exportableAppState;
}

function serializeCanvasNotebookScene(
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles
): string {
  const serialized = serializeAsJSON(
    elements,
    stripHostControlledAppState(appState),
    files,
    'local'
  );

  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  parsed.source = EXCALIDRAW_FILE_SOURCE;
  return JSON.stringify(parsed, null, 2);
}

export function ExcalidrawEditor({ path, value, onChange }: ExcalidrawEditorProps) {
  const t = useTranslations('notebook');
  const locale = useLocale();
  const { resolvedTheme } = useTheme();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastSerializedRef = useRef(value);
  const activePathRef = useRef(path);
  const [textModePath, setTextModePath] = useState<string | null>(null);
  const [contentOverride, setContentOverride] = useState<{
    path: string;
    content: string;
    nonce: number;
  } | null>(null);

  const effectiveContent = contentOverride?.path === path ? contentOverride.content : value;
  const session = useMemo(() => parseExcalidrawContent(effectiveContent), [effectiveContent]);
  const resetNonce = contentOverride?.path === path ? contentOverride.nonce : 0;
  const isTextMode = textModePath === path;

  useEffect(() => {
    if (activePathRef.current !== path) {
      activePathRef.current = path;
      lastSerializedRef.current = effectiveContent;
    }
  }, [effectiveContent, path]);

  const langCode = useMemo(() => (
    locale.toLowerCase().startsWith('de') ? 'de-DE' : 'en'
  ), [locale]);

  const handleExcalidrawChange = useCallback((
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles
  ) => {
    const serialized = serializeCanvasNotebookScene(elements, appState, files);

    if (serialized === lastSerializedRef.current) return;
    lastSerializedRef.current = serialized;
    onChange(serialized);
  }, [onChange]);

  const handleInitializeDrawing = useCallback(() => {
    const nextContent = createEmptyExcalidrawFileContent();
    lastSerializedRef.current = nextContent;
    onChange(nextContent);
    setTextModePath(null);
    setContentOverride({ path, content: nextContent, nonce: Date.now() });
  }, [onChange, path]);

  if (isTextMode) {
    return <CodeEditor value={value} onChange={onChange} readOnly={false} path={path} />;
  }

  if (session.invalid) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <div className="flex max-w-md flex-col items-center gap-2">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <h3 className="text-base font-semibold text-foreground">{t('excalidrawInvalidTitle')}</h3>
          <p className="text-sm text-muted-foreground">{t('excalidrawInvalidDescription')}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={() => setTextModePath(path)}>
            <Code2 className="h-4 w-4" />
            {t('openAsText')}
          </Button>
          <Button variant="secondary" onClick={handleInitializeDrawing}>
            <RefreshCw className="h-4 w-4" />
            {t('initializeExcalidraw')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 bg-background">
      <Excalidraw
        key={`${path}:${resetNonce}`}
        excalidrawAPI={(api) => { apiRef.current = api; }}
        initialData={session.initialData}
        onChange={handleExcalidrawChange}
        langCode={langCode}
        theme={resolvedTheme}
        name={path.split('/').pop() ?? path}
        isCollaborating={false}
        aiEnabled={false}
        autoFocus
        UIOptions={{
          dockedSidebarBreakpoint: 880,
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: false,
            export: {
              saveFileToDisk: false,
            },
          },
          tools: {
            image: true,
          },
        }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Logo />
            <WelcomeScreen.Center.Heading>
              {t('excalidrawEmptyWelcome')}
            </WelcomeScreen.Center.Heading>
            <WelcomeScreen.Center.Menu>
              <WelcomeScreen.Center.MenuItemHelp />
            </WelcomeScreen.Center.Menu>
          </WelcomeScreen.Center>
          <WelcomeScreen.Hints.ToolbarHint>
            {t('excalidrawWelcomeHint')}
          </WelcomeScreen.Hints.ToolbarHint>
        </WelcomeScreen>
        <Footer>
          <div className="pointer-events-none select-none rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
            {t('excalidrawFooter')}
          </div>
        </Footer>
      </Excalidraw>
    </div>
  );
}
