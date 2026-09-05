export type NotebookMainSurface = 'chat' | 'document' | 'email' | 'browser';
export type NotebookContextSurface = Extract<NotebookMainSurface, 'email' | 'browser'>;
export type NotebookWorkSurface = Exclude<NotebookMainSurface, 'chat'>;
export type NotebookViewport = 'mobile' | 'desktop-compact' | 'desktop-wide';

export type NotebookLayoutState = {
  mainSurface: NotebookMainSurface;
  lastWorkSurface: NotebookWorkSurface | null;
  documentAvailable: boolean;
  emailAvailable: boolean;
  browserAvailable: boolean;
  explorerOpen: boolean;
  chatDocked: boolean;
  terminalOpen: boolean;
  viewport: NotebookViewport;
};

export type NotebookLayoutAction =
  | {
      type: 'HYDRATE_PREFERENCES';
      chatDocked: boolean;
      explorerOpen: boolean;
      terminalOpen: boolean;
    }
  | { type: 'VIEWPORT_CHANGED'; viewport: NotebookViewport }
  | { type: 'SHOW_CHAT' }
  | { type: 'SHOW_SURFACE'; surface: NotebookWorkSurface }
  | { type: 'DOCUMENT_OPENED'; dockChatIfFull?: boolean }
  | { type: 'DOCUMENT_CLOSED' }
  | { type: 'CONTEXT_OPENED'; surface: NotebookContextSurface; activate?: boolean }
  | { type: 'CONTEXT_CLOSED'; surface: NotebookContextSurface }
  | { type: 'SET_EXPLORER'; open: boolean }
  | { type: 'SET_CHAT_DOCKED'; docked: boolean }
  | { type: 'SET_TERMINAL'; open: boolean };

export type NotebookLayoutPreferences = {
  version: 2;
  explorerOpen: boolean;
  explorerWidth: number;
  chatDocked: boolean;
  chatWidth: number;
  terminalOpen: boolean;
};

export const NOTEBOOK_LAYOUT_STORAGE_KEY = 'canvas.notebookLayout.v2';
export const NOTEBOOK_EXPLORER_MIN_WIDTH = 300;
export const NOTEBOOK_EXPLORER_DEFAULT_WIDTH = 360;
export const NOTEBOOK_EXPLORER_MAX_WIDTH = 640;
export const NOTEBOOK_CHAT_MIN_WIDTH = 340;
export const NOTEBOOK_CHAT_DEFAULT_WIDTH = 420;
export const NOTEBOOK_CHAT_MAX_WIDTH = 680;
export const NOTEBOOK_DOCUMENT_MIN_WIDTH = 440;

const LEGACY_EXPLORER_VISIBLE_KEY = 'canvas.notebookDesktopSidebarVisible';
const LEGACY_EXPLORER_WIDTH_KEY = 'canvas.leftSidebarWidth';
const LEGACY_CHAT_WIDTH_KEY = 'canvas.notebookChatWidth';
const LEGACY_TERMINAL_VISIBLE_KEY = 'canvas.terminalVisible';

export const initialNotebookLayoutState: NotebookLayoutState = {
  mainSurface: 'chat',
  lastWorkSurface: null,
  documentAvailable: false,
  emailAvailable: false,
  browserAvailable: false,
  explorerOpen: true,
  chatDocked: false,
  terminalOpen: false,
  viewport: 'desktop-wide',
};

function isSurfaceAvailable(
  state: NotebookLayoutState,
  surface: NotebookWorkSurface | null,
): surface is NotebookWorkSurface {
  if (surface === 'document') return state.documentAvailable;
  if (surface === 'email') return state.emailAvailable;
  if (surface === 'browser') return state.browserAvailable;
  return false;
}

function fallbackWorkSurface(
  state: NotebookLayoutState,
  excluded?: NotebookWorkSurface,
): NotebookWorkSurface | null {
  if (state.lastWorkSurface !== excluded && isSurfaceAvailable(state, state.lastWorkSurface)) {
    return state.lastWorkSurface;
  }

  for (const candidate of ['document', 'email', 'browser'] as const) {
    if (candidate !== excluded && isSurfaceAvailable(state, candidate)) return candidate;
  }
  return null;
}

function withMainSurface(
  state: NotebookLayoutState,
  surface: NotebookMainSurface,
): NotebookLayoutState {
  if (surface === 'chat') {
    return {
      ...state,
      mainSurface: 'chat',
      chatDocked: false,
    };
  }

  if (!isSurfaceAvailable(state, surface)) return state;
  return {
    ...state,
    mainSurface: surface,
    lastWorkSurface: surface,
  };
}

function withEmptyWorkbenchBesideChat(state: NotebookLayoutState): NotebookLayoutState {
  return {
    ...state,
    mainSurface: 'document',
    lastWorkSurface: null,
    chatDocked: true,
  };
}

function withChatDocked(state: NotebookLayoutState, docked: boolean): NotebookLayoutState {
  if (!docked) return { ...state, chatDocked: false };
  if (state.viewport !== 'desktop-wide') return withMainSurface(state, 'chat');
  if (state.mainSurface !== 'chat') return { ...state, chatDocked: true };
  const fallback = fallbackWorkSurface(state);
  return fallback
    ? { ...withMainSurface(state, fallback), chatDocked: true }
    : withEmptyWorkbenchBesideChat(state);
}

export function notebookLayoutReducer(
  state: NotebookLayoutState,
  action: NotebookLayoutAction,
): NotebookLayoutState {
  switch (action.type) {
    case 'HYDRATE_PREFERENCES': {
      const hydratedState = {
        ...state,
        explorerOpen: state.viewport === 'mobile' ? false : action.explorerOpen,
        terminalOpen: state.viewport === 'mobile' ? false : action.terminalOpen,
      };
      return withChatDocked(hydratedState, action.chatDocked);
    }

    case 'VIEWPORT_CHANGED': {
      if (action.viewport === state.viewport) return state;
      const compacted = action.viewport !== 'desktop-wide' && state.chatDocked;
      const emptyDockedWorkbenchCompacted = compacted
        && state.mainSurface === 'document'
        && !state.documentAvailable;
      return {
        ...state,
        viewport: action.viewport,
        explorerOpen: action.viewport === 'mobile' ? false : state.explorerOpen,
        terminalOpen: action.viewport === 'mobile' ? false : state.terminalOpen,
        chatDocked: compacted ? false : state.chatDocked,
        mainSurface: emptyDockedWorkbenchCompacted ? 'chat' : state.mainSurface,
      };
    }

    case 'SHOW_CHAT':
      return withMainSurface(state, 'chat');

    case 'SHOW_SURFACE':
      return withMainSurface(state, action.surface);

    case 'DOCUMENT_OPENED': {
      const nextState = withMainSurface(
        {
          ...state,
          documentAvailable: true,
        },
        'document',
      );
      return action.dockChatIfFull
        && state.mainSurface === 'chat'
        && state.viewport === 'desktop-wide'
        ? { ...nextState, chatDocked: true }
        : nextState;
    }

    case 'DOCUMENT_CLOSED': {
      const nextState = {
        ...state,
        documentAvailable: false,
        lastWorkSurface: state.lastWorkSurface === 'document' ? null : state.lastWorkSurface,
      };
      if (state.mainSurface !== 'document') return nextState;
      const fallback = fallbackWorkSurface(nextState, 'document');
      if (!fallback && state.chatDocked && state.viewport === 'desktop-wide') {
        return withEmptyWorkbenchBesideChat(nextState);
      }
      return fallback ? withMainSurface(nextState, fallback) : withMainSurface(nextState, 'chat');
    }

    case 'CONTEXT_OPENED': {
      const availabilityKey = action.surface === 'email' ? 'emailAvailable' : 'browserAvailable';
      if (action.activate === false) return { ...state, [availabilityKey]: true };
      return withMainSurface(
        {
          ...state,
          [availabilityKey]: true,
        },
        action.surface,
      );
    }

    case 'CONTEXT_CLOSED': {
      const availabilityKey = action.surface === 'email' ? 'emailAvailable' : 'browserAvailable';
      const nextState = {
        ...state,
        [availabilityKey]: false,
        lastWorkSurface: state.lastWorkSurface === action.surface ? null : state.lastWorkSurface,
      };
      if (state.mainSurface !== action.surface) return nextState;
      const fallback = fallbackWorkSurface(nextState, action.surface);
      if (!fallback && state.chatDocked && state.viewport === 'desktop-wide') {
        return withEmptyWorkbenchBesideChat(nextState);
      }
      return fallback ? withMainSurface(nextState, fallback) : withMainSurface(nextState, 'chat');
    }

    case 'SET_EXPLORER':
      return {
        ...state,
        explorerOpen: state.viewport === 'mobile' ? false : action.open,
      };

    case 'SET_CHAT_DOCKED':
      return withChatDocked(state, action.docked);

    case 'SET_TERMINAL':
      return {
        ...state,
        terminalOpen: state.viewport === 'mobile' ? false : action.open,
      };
  }
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function clampNotebookPanelWidth(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function storedBoolean(storage: Storage, key: string, fallback: boolean) {
  const stored = storage.getItem(key);
  return stored === null ? fallback : stored === 'true';
}

function storedNumber(storage: Storage, key: string, fallback: number) {
  const value = Number(storage.getItem(key));
  return Number.isFinite(value) ? value : fallback;
}

export function defaultNotebookLayoutPreferences(): NotebookLayoutPreferences {
  return {
    version: 2,
    explorerOpen: true,
    explorerWidth: NOTEBOOK_EXPLORER_DEFAULT_WIDTH,
    chatDocked: true,
    chatWidth: NOTEBOOK_CHAT_DEFAULT_WIDTH,
    terminalOpen: false,
  };
}

export function readNotebookLayoutPreferences(storage: Storage): NotebookLayoutPreferences {
  const defaults = defaultNotebookLayoutPreferences();
  const stored = storage.getItem(NOTEBOOK_LAYOUT_STORAGE_KEY);

  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<NotebookLayoutPreferences>;
      if (parsed.version === 2) {
        return {
          version: 2,
          explorerOpen: typeof parsed.explorerOpen === 'boolean' ? parsed.explorerOpen : defaults.explorerOpen,
          explorerWidth: clampNotebookPanelWidth(
            finiteNumber(parsed.explorerWidth, defaults.explorerWidth),
            NOTEBOOK_EXPLORER_MIN_WIDTH,
            NOTEBOOK_EXPLORER_MAX_WIDTH,
          ),
          chatDocked: typeof parsed.chatDocked === 'boolean' ? parsed.chatDocked : defaults.chatDocked,
          chatWidth: clampNotebookPanelWidth(
            finiteNumber(parsed.chatWidth, defaults.chatWidth),
            NOTEBOOK_CHAT_MIN_WIDTH,
            NOTEBOOK_CHAT_MAX_WIDTH,
          ),
          terminalOpen: typeof parsed.terminalOpen === 'boolean' ? parsed.terminalOpen : defaults.terminalOpen,
        };
      }
    } catch {
      // Fall through to one-time legacy migration.
    }
  }

  return {
    version: 2,
    explorerOpen: storedBoolean(storage, LEGACY_EXPLORER_VISIBLE_KEY, defaults.explorerOpen),
    explorerWidth: clampNotebookPanelWidth(
      storedNumber(storage, LEGACY_EXPLORER_WIDTH_KEY, defaults.explorerWidth),
      NOTEBOOK_EXPLORER_MIN_WIDTH,
      NOTEBOOK_EXPLORER_MAX_WIDTH,
    ),
    chatDocked: defaults.chatDocked,
    chatWidth: clampNotebookPanelWidth(
      storedNumber(storage, LEGACY_CHAT_WIDTH_KEY, defaults.chatWidth),
      NOTEBOOK_CHAT_MIN_WIDTH,
      NOTEBOOK_CHAT_MAX_WIDTH,
    ),
    terminalOpen: storedBoolean(storage, LEGACY_TERMINAL_VISIBLE_KEY, defaults.terminalOpen),
  };
}

export function writeNotebookLayoutPreferences(
  storage: Storage,
  preferences: NotebookLayoutPreferences,
) {
  storage.setItem(NOTEBOOK_LAYOUT_STORAGE_KEY, JSON.stringify({
    ...preferences,
    version: 2,
    explorerWidth: clampNotebookPanelWidth(
      preferences.explorerWidth,
      NOTEBOOK_EXPLORER_MIN_WIDTH,
      NOTEBOOK_EXPLORER_MAX_WIDTH,
    ),
    chatWidth: clampNotebookPanelWidth(
      preferences.chatWidth,
      NOTEBOOK_CHAT_MIN_WIDTH,
      NOTEBOOK_CHAT_MAX_WIDTH,
    ),
  } satisfies NotebookLayoutPreferences));
}
