export const EXCALIDRAW_FILE_EXTENSION = 'excalidraw';
export const EXCALIDRAW_FILE_SOURCE = 'canvas-notebook';

export function isExcalidrawFilePath(path: string): boolean {
  return path.toLowerCase().endsWith(`.${EXCALIDRAW_FILE_EXTENSION}`);
}

export function createEmptyExcalidrawFileContent(): string {
  return `${JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: EXCALIDRAW_FILE_SOURCE,
      elements: [],
      appState: {
        viewBackgroundColor: '#ffffff',
      },
      files: {},
    },
    null,
    2
  )}\n`;
}
