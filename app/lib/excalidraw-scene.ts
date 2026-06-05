import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';

export interface ExcalidrawSession {
  initialData: ExcalidrawInitialDataState | null;
  invalid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseExcalidrawContent(content: string): ExcalidrawSession {
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
