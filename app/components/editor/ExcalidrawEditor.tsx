'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Code2, RefreshCw, Workflow } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
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
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useTheme } from '@/app/components/ThemeProvider';
import { EXCALIDRAW_FILE_SOURCE, createEmptyExcalidrawFileContent } from '@/app/lib/excalidraw-file';
import { parseExcalidrawContent } from '@/app/lib/excalidraw-scene';
import { CodeEditor } from './CodeEditor';

interface ExcalidrawEditorProps {
  path: string;
  value: string;
  onChange: (content: string) => void;
}

interface SceneBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const MERMAID_PLACEHOLDER = `flowchart TD
  A[Request] --> B{Authenticated?}
  B -->|Yes| C[Open workspace]
  B -->|No| D[Show login]`;

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

function toUpdateSceneAppState(appState: ExcalidrawInitialDataState['appState']) {
  if (!appState) return null;

  return {
    ...appState,
    name: appState.name ?? null,
  } as Pick<AppState, keyof AppState>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function getElementBounds(element: Pick<OrderedExcalidrawElement, 'x' | 'y' | 'width' | 'height'> & {
  points?: readonly (readonly [number, number])[];
}): SceneBounds {
  if (Array.isArray(element.points) && element.points.length > 0) {
    const xs = element.points.map(([pointX]) => element.x + pointX);
    const ys = element.points.map(([, pointY]) => element.y + pointY);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  }

  return {
    minX: Math.min(element.x, element.x + element.width),
    minY: Math.min(element.y, element.y + element.height),
    maxX: Math.max(element.x, element.x + element.width),
    maxY: Math.max(element.y, element.y + element.height),
  };
}

function getSceneBounds(elements: readonly OrderedExcalidrawElement[]): SceneBounds | null {
  const visibleElements = elements.filter((element) => !element.isDeleted);
  if (!visibleElements.length) return null;

  return visibleElements.reduce<SceneBounds>((bounds, element) => {
    const elementBounds = getElementBounds(element);
    return {
      minX: Math.min(bounds.minX, elementBounds.minX),
      minY: Math.min(bounds.minY, elementBounds.minY),
      maxX: Math.max(bounds.maxX, elementBounds.maxX),
      maxY: Math.max(bounds.maxY, elementBounds.maxY),
    };
  }, getElementBounds(visibleElements[0]));
}

function getImportOffset(
  existingElements: readonly OrderedExcalidrawElement[],
  importedElements: readonly OrderedExcalidrawElement[]
): { x: number; y: number } {
  const importedBounds = getSceneBounds(importedElements);
  if (!importedBounds) return { x: 0, y: 0 };

  const existingBounds = getSceneBounds(existingElements);
  if (!existingBounds) {
    return {
      x: 40 - importedBounds.minX,
      y: 40 - importedBounds.minY,
    };
  }

  return {
    x: existingBounds.maxX + 160 - importedBounds.minX,
    y: existingBounds.minY - importedBounds.minY,
  };
}

function offsetElements(
  elements: readonly OrderedExcalidrawElement[],
  offset: { x: number; y: number }
): OrderedExcalidrawElement[] {
  return elements.map((element) => ({
    ...element,
    x: element.x + offset.x,
    y: element.y + offset.y,
  })) as OrderedExcalidrawElement[];
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
  const [mermaidDialogOpen, setMermaidDialogOpen] = useState(false);
  const [mermaidSyntax, setMermaidSyntax] = useState('');
  const [mermaidError, setMermaidError] = useState<string | null>(null);
  const [isImportingMermaid, setIsImportingMermaid] = useState(false);

  const effectiveContent = contentOverride?.path === path ? contentOverride.content : value;
  const session = useMemo(() => parseExcalidrawContent(effectiveContent), [effectiveContent]);
  const resetNonce = contentOverride?.path === path ? contentOverride.nonce : 0;
  const isTextMode = textModePath === path;

  useEffect(() => {
    if (activePathRef.current !== path) {
      activePathRef.current = path;
      lastSerializedRef.current = effectiveContent;
      return;
    }

    if (effectiveContent === lastSerializedRef.current) {
      return;
    }

    lastSerializedRef.current = effectiveContent;

    if (isTextMode || session.invalid || !session.initialData) {
      return;
    }

    const api = apiRef.current;
    if (!api) {
      return;
    }

    if (session.initialData.files) {
      api.addFiles(Object.values(session.initialData.files));
    }

    api.updateScene({
      elements: session.initialData.elements ?? [],
      appState: toUpdateSceneAppState(session.initialData.appState),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [effectiveContent, isTextMode, path, session.initialData, session.invalid]);

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

  const handleMermaidDialogOpenChange = useCallback((open: boolean) => {
    if (isImportingMermaid) return;
    setMermaidDialogOpen(open);
    if (!open) {
      setMermaidError(null);
    }
  }, [isImportingMermaid]);

  const handleImportMermaid = useCallback(async () => {
    const definition = mermaidSyntax.trim();
    if (!definition) {
      setMermaidError(t('mermaidImportEmpty'));
      return;
    }

    const api = apiRef.current;
    if (!api) {
      setMermaidError(t('mermaidImportUnavailable'));
      return;
    }

    setIsImportingMermaid(true);
    setMermaidError(null);

    try {
      const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
      const { elements, files } = await parseMermaidToExcalidraw(definition, {
        flowchart: {
          curve: 'linear',
        },
        themeVariables: {
          fontSize: '22px',
        },
        maxEdges: 1000,
        maxTextSize: 50000,
      });

      const importedElements = convertToExcalidrawElements(
        elements as ExcalidrawElementSkeleton[],
        { regenerateIds: true }
      );

      if (!importedElements.length) {
        setMermaidError(t('mermaidImportNoElements'));
        return;
      }

      const currentElements = api.getSceneElementsIncludingDeleted();
      const offset = getImportOffset(currentElements, importedElements);
      const positionedElements = offsetElements(importedElements, offset);

      if (files) {
        api.addFiles(Object.values(files));
      }

      api.updateScene({
        elements: [...currentElements, ...positionedElements],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      window.requestAnimationFrame(() => {
        api.scrollToContent(positionedElements, {
          fitToContent: true,
          animate: true,
        });
      });
      api.setToast({ message: t('mermaidImportSuccess'), duration: 3000 });
      setMermaidSyntax('');
      setMermaidDialogOpen(false);
    } catch (error) {
      setMermaidError(t('mermaidImportFailed', { message: getErrorMessage(error) }));
    } finally {
      setIsImportingMermaid(false);
    }
  }, [mermaidSyntax, t]);

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
    <>
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
            <MainMenu.Item
              icon={<Workflow className="h-4 w-4" />}
              onSelect={() => setMermaidDialogOpen(true)}
            >
              {t('importMermaid')}
            </MainMenu.Item>
            <MainMenu.Separator />
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
      <Dialog open={mermaidDialogOpen} onOpenChange={handleMermaidDialogOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('mermaidImportTitle')}</DialogTitle>
            <DialogDescription>{t('mermaidImportDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Textarea
              value={mermaidSyntax}
              onChange={(event) => {
                setMermaidSyntax(event.target.value);
                if (mermaidError) setMermaidError(null);
              }}
              placeholder={MERMAID_PLACEHOLDER}
              spellCheck={false}
              className="min-h-72 resize-y font-mono text-sm leading-6"
              aria-label={t('mermaidImportTextareaLabel')}
            />
            {mermaidError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {mermaidError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleMermaidDialogOpenChange(false)}
              disabled={isImportingMermaid}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              onClick={handleImportMermaid}
              disabled={isImportingMermaid || !mermaidSyntax.trim()}
            >
              <Workflow className="h-4 w-4" />
              {isImportingMermaid ? t('mermaidImporting') : t('importMermaid')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
