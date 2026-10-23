import type { Page } from '@playwright/test';

type FocusStage = 'installed' | 'before_insert' | 'after_insert' | 'focus_assertion_failed';
type FocusTarget = 'editor' | 'within_editor' | 'dialog' | 'menu_trigger' | 'menu' | 'other' | 'none';
type FocusRecord = {
  event: 'focusin' | 'focusout' | 'snapshot';
  stage: FocusStage | null;
  relativeTimeMs: number;
  eventTarget: FocusTarget;
  activeIsEditor: boolean;
  withinEditor: boolean;
  inDialog: boolean;
  inMenu: boolean;
  isMenuTrigger: boolean;
  isConnected: boolean;
  rootIsConnected: boolean;
  rootIsInitial: boolean;
  editorAvailable: boolean;
  editorIsInitial: boolean | null;
  editorIsDestroyed: boolean | null;
  editorIsEditable: boolean | null;
  editorDomIsCurrentRoot: boolean | null;
  editorViewHasFocus: boolean | null;
  editorHasFocusedClass: boolean;
  editorReadFailed: boolean;
};
export type PassiveEditorFocusSnapshot = {
  version: 1;
  overflowed: boolean;
  captureFailed: boolean;
  events: FocusRecord[];
  snapshots: FocusRecord[];
};
export type PassiveEditorFocusObservation = {
  snapshot(stage: Exclude<FocusStage, 'installed'>): Promise<void>;
  read(): Promise<PassiveEditorFocusSnapshot>;
  dispose(): Promise<void>;
};
type BrowserEditor = {
  isDestroyed: boolean;
  isEditable: boolean;
  view: { dom: HTMLElement; hasFocus(): boolean };
};
type ObservationWindow = Window & {
  __canvasPassiveEditorFocusObservation?: {
    snapshot(stage: FocusStage): void;
    read(): PassiveEditorFocusSnapshot;
    dispose(): void;
  };
};

/** Reads focus state only. Never focuses, schedules work, changes DOM/native
 * content, or exports text, attributes, identifiers or editor objects. */
export async function installPassiveEditorFocusObservation(page: Page, selector: string): Promise<PassiveEditorFocusObservation> {
  await page.evaluate(({ selector }) => {
    const targetWindow = window as ObservationWindow;
    if (targetWindow.__canvasPassiveEditorFocusObservation) throw new Error('A passive focus observer is already installed.');
    const startedAt = performance.now();
    const initialRoot = document.querySelector<HTMLElement>(selector);
    const editorFor = (root: HTMLElement | null) => (root as (HTMLElement & { editor?: BrowserEditor }) | null)?.editor;
    const initialEditor = editorFor(initialRoot);
    const data: PassiveEditorFocusSnapshot = { version: 1, overflowed: false, captureFailed: false, events: [], snapshots: [] };
    const record = (event: FocusRecord['event'], stage: FocusStage | null, eventTarget: EventTarget | null): FocusRecord => {
      const root = document.querySelector<HTMLElement>(selector), active = document.activeElement;
      const editor = editorFor(root);
      const classify = (target: EventTarget | null): FocusTarget => {
        if (!target) return 'none';
        if (target === root) return 'editor';
        if (target instanceof Node && root?.contains(target)) return 'within_editor';
        if (!(target instanceof Element)) return 'other';
        if (target.closest('[role="dialog"]')) return 'dialog';
        if (target.closest('[aria-haspopup="menu"]')) return 'menu_trigger';
        if (target.closest('[role="menu"]')) return 'menu';
        return 'other';
      };
      const result: FocusRecord = {
        event, stage, relativeTimeMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
        eventTarget: classify(eventTarget), activeIsEditor: !!root && active === root,
        withinEditor: !!root && !!active && root.contains(active),
        inDialog: !!active?.closest('[role="dialog"]'), inMenu: !!active?.closest('[role="menu"]'),
        isMenuTrigger: !!active?.closest('[aria-haspopup="menu"]'), isConnected: active?.isConnected === true,
        rootIsConnected: root?.isConnected === true, rootIsInitial: !!root && root === initialRoot,
        editorAvailable: !!editor, editorIsInitial: editor ? editor === initialEditor : null,
        editorIsDestroyed: null, editorIsEditable: null, editorDomIsCurrentRoot: null, editorViewHasFocus: null,
        editorHasFocusedClass: root?.classList.contains('ProseMirror-focused') === true, editorReadFailed: false,
      };
      if (editor) {
        try {
          result.editorIsDestroyed = editor.isDestroyed;
          result.editorIsEditable = editor.isEditable;
          const view = editor.view;
          result.editorDomIsCurrentRoot = view.dom === root;
          result.editorViewHasFocus = view.hasFocus();
        } catch { result.editorReadFailed = true; }
      }
      return result;
    };
    const onFocus = (event: FocusEvent) => {
      if (data.events.length >= 128) { data.overflowed = true; return; }
      try { data.events.push(record(event.type === 'focusin' ? 'focusin' : 'focusout', null, event.target)); }
      catch { data.captureFailed = true; }
    };
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onFocus, true);
    const state: NonNullable<ObservationWindow['__canvasPassiveEditorFocusObservation']> = {
      snapshot(stage) {
        if (data.snapshots.length >= 4) { data.overflowed = true; return; }
        try { data.snapshots.push(record('snapshot', stage, null)); }
        catch { data.captureFailed = true; }
      },
      read: () => ({ ...data, events: data.events.map(event => ({ ...event })), snapshots: data.snapshots.map(snapshot => ({ ...snapshot })) }),
      dispose() {
        document.removeEventListener('focusin', onFocus, true);
        document.removeEventListener('focusout', onFocus, true);
        delete targetWindow.__canvasPassiveEditorFocusObservation;
      },
    };
    targetWindow.__canvasPassiveEditorFocusObservation = state;
    state.snapshot('installed');
  }, { selector });
  return {
    snapshot: stage => page.evaluate(stage => (window as ObservationWindow).__canvasPassiveEditorFocusObservation?.snapshot(stage), stage),
    read: () => page.evaluate(() => {
      const state = (window as ObservationWindow).__canvasPassiveEditorFocusObservation;
      if (!state) throw new Error('The passive focus observer is unavailable.');
      return state.read();
    }),
    dispose: () => page.evaluate(() => (window as ObservationWindow).__canvasPassiveEditorFocusObservation?.dispose()),
  };
}
