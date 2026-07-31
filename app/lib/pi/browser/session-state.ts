import type {
  BrowserRuntimeTab,
  BrowserSessionSnapshot,
  BrowserSessionSnapshotInput,
  BrowserViewControlMode,
} from './types';

const MAX_RUNTIME_TABS = 12;
const MAX_TAB_TITLE_LENGTH = 160;
const MAX_TAB_ID_LENGTH = 128;
const MAX_URL_LENGTH = 600;

type BrowserSessionStateListener = (snapshot: BrowserSessionSnapshot) => void;

type BrowserSessionStateRecord = {
  listeners: Set<BrowserSessionStateListener>;
  signature: string;
  snapshot: BrowserSessionSnapshot;
};

type BrowserSessionStateGlobal = typeof globalThis & {
  __canvasBrowserSessionStatesV1?: Map<string, BrowserSessionStateRecord>;
};

const stateGlobal = globalThis as BrowserSessionStateGlobal;
const sessionStates = stateGlobal.__canvasBrowserSessionStatesV1
  ?? new Map<string, BrowserSessionStateRecord>();
stateGlobal.__canvasBrowserSessionStatesV1 = sessionStates;

function boundedText(value: unknown, maxLength: number): string {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return normalized.slice(0, maxLength);
}

export function sanitizeBrowserSessionUrl(value: unknown): string | null {
  const raw = boundedText(value, MAX_URL_LENGTH * 2);
  if (!raw) return null;
  if (raw === 'about:blank') return raw;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().slice(0, MAX_URL_LENGTH);
  } catch {
    return null;
  }
}

function sanitizeTab(tab: BrowserRuntimeTab): BrowserRuntimeTab | null {
  const id = boundedText(tab.id, MAX_TAB_ID_LENGTH);
  if (!id) return null;
  return {
    id,
    title: boundedText(tab.title, MAX_TAB_TITLE_LENGTH),
    url: sanitizeBrowserSessionUrl(tab.url) ?? '',
    active: Boolean(tab.active),
  };
}

function normalizeControlMode(value: BrowserViewControlMode): BrowserViewControlMode {
  return value === 'user' || value === 'view' ? value : 'agent';
}

export function normalizeBrowserSessionSnapshot(
  input: BrowserSessionSnapshotInput,
  revision: number,
): BrowserSessionSnapshot {
  if (!input.running) {
    return {
      revision,
      running: false,
      controlMode: 'agent',
      activeTabId: null,
      activeTitle: null,
      activeUrl: null,
      tabCount: 0,
      tabs: [],
      hasPendingDialog: false,
    };
  }

  const sanitizedTabs = input.tabs
    .map(sanitizeTab)
    .filter((tab): tab is BrowserRuntimeTab => Boolean(tab));
  const activeTabId = boundedText(input.activeTabId, MAX_TAB_ID_LENGTH) || null;
  const prioritizedTabs = [
    ...sanitizedTabs.filter((tab) => tab.id === activeTabId || tab.active),
    ...sanitizedTabs.filter((tab) => tab.id !== activeTabId && !tab.active),
  ].slice(0, MAX_RUNTIME_TABS);
  const activeTab = prioritizedTabs.find((tab) => tab.id === activeTabId)
    ?? prioritizedTabs.find((tab) => tab.active)
    ?? null;

  return {
    revision,
    running: true,
    controlMode: normalizeControlMode(input.controlMode),
    activeTabId: activeTab?.id ?? activeTabId,
    activeTitle: boundedText(activeTab?.title || input.activeTitle, MAX_TAB_TITLE_LENGTH) || null,
    activeUrl: sanitizeBrowserSessionUrl(activeTab?.url || input.activeUrl),
    tabCount: Math.max(sanitizedTabs.length, Math.max(0, Math.floor(input.tabCount))),
    tabs: prioritizedTabs,
    hasPendingDialog: Boolean(input.hasPendingDialog),
  };
}

export function publishBrowserSessionSnapshot(
  contextKey: string,
  input: BrowserSessionSnapshotInput,
): BrowserSessionSnapshot {
  const existing = sessionStates.get(contextKey);
  const nextRevision = (existing?.snapshot.revision ?? 0) + 1;
  const normalized = normalizeBrowserSessionSnapshot(input, nextRevision);
  const signature = JSON.stringify({ ...normalized, revision: 0 });
  if (existing?.signature === signature) {
    return existing.snapshot;
  }

  const record: BrowserSessionStateRecord = existing
    ? { ...existing, signature, snapshot: normalized }
    : { listeners: new Set(), signature, snapshot: normalized };
  sessionStates.set(contextKey, record);
  for (const listener of record.listeners) {
    listener(normalized);
  }
  return normalized;
}

export function getBrowserSessionSnapshot(contextKey: string): BrowserSessionSnapshot | null {
  return sessionStates.get(contextKey)?.snapshot ?? null;
}

export function subscribeBrowserSessionSnapshot(
  contextKey: string,
  listener: BrowserSessionStateListener,
): () => void {
  const existing = sessionStates.get(contextKey);
  if (existing) {
    existing.listeners.add(listener);
  } else {
    sessionStates.set(contextKey, {
      listeners: new Set([listener]),
      signature: '',
      snapshot: normalizeBrowserSessionSnapshot({
        running: false,
        controlMode: 'agent',
        activeTabId: null,
        activeTitle: null,
        activeUrl: null,
        tabCount: 0,
        tabs: [],
        hasPendingDialog: false,
      }, 0),
    });
  }

  return () => {
    const record = sessionStates.get(contextKey);
    record?.listeners.delete(listener);
  };
}
