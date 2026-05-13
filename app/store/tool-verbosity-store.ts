import { create } from 'zustand';

export type ToolVerbosity = 'minimal' | 'subtle' | 'verbose';

const STORAGE_KEY = 'canvas-tool-verbosity';
const DEFAULT_TOOL_VERBOSITY: ToolVerbosity = 'subtle';

interface ToolVerbosityState {
  toolVerbosity: ToolVerbosity;
  setToolVerbosity: (value: ToolVerbosity) => void;
}

function isToolVerbosity(value: string | null): value is ToolVerbosity {
  return value === 'minimal' || value === 'subtle' || value === 'verbose';
}

function readFromStorage(): ToolVerbosity {
  if (typeof window === 'undefined') return DEFAULT_TOOL_VERBOSITY;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isToolVerbosity(stored) ? stored : DEFAULT_TOOL_VERBOSITY;
  } catch {
    return DEFAULT_TOOL_VERBOSITY;
  }
}

function writeToStorage(value: ToolVerbosity) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // ignore
  }
}

export const useToolVerbosityStore = create<ToolVerbosityState>(() => ({
  toolVerbosity: readFromStorage(),
  setToolVerbosity: (value) => {
    writeToStorage(value);
    useToolVerbosityStore.setState({ toolVerbosity: value });
  },
}));
