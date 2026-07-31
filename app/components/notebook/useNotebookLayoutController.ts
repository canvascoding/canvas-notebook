'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import {
  NOTEBOOK_CHAT_DEFAULT_WIDTH,
  NOTEBOOK_CHAT_MAX_WIDTH,
  NOTEBOOK_CHAT_MIN_WIDTH,
  NOTEBOOK_DOCUMENT_MIN_WIDTH,
  NOTEBOOK_EXPLORER_DEFAULT_WIDTH,
  NOTEBOOK_EXPLORER_MAX_WIDTH,
  NOTEBOOK_EXPLORER_MIN_WIDTH,
  defaultNotebookLayoutPreferences,
  initialNotebookLayoutState,
  notebookLayoutReducer,
  readNotebookLayoutPreferences,
  writeNotebookLayoutPreferences,
  type NotebookViewport,
} from '@/app/lib/notebook/layout-state';

function classifyViewport(
  viewportWidth: number,
  explorerOpen: boolean,
  explorerWidth: number,
  chatWidth: number,
): NotebookViewport {
  if (viewportWidth < 768) return 'mobile';
  const workspaceWidth = viewportWidth - (explorerOpen ? explorerWidth : 0);
  return workspaceWidth >= NOTEBOOK_DOCUMENT_MIN_WIDTH + chatWidth
    ? 'desktop-wide'
    : 'desktop-compact';
}

export function useNotebookLayoutController() {
  const [state, dispatch] = useReducer(notebookLayoutReducer, initialNotebookLayoutState);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [explorerWidth, setExplorerWidthState] = useState(NOTEBOOK_EXPLORER_DEFAULT_WIDTH);
  const [chatWidth, setChatWidthState] = useState(NOTEBOOK_CHAT_DEFAULT_WIDTH);
  const [preferencesHydrated, setPreferencesHydrated] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      let preferences = defaultNotebookLayoutPreferences();
      try {
        preferences = readNotebookLayoutPreferences(window.localStorage);
      } catch {
        // Layout persistence is optional; the workbench remains usable without it.
      }
      setExplorerWidthState(preferences.explorerWidth);
      setChatWidthState(preferences.chatWidth);
      dispatch({
        type: 'HYDRATE_PREFERENCES',
        explorerOpen: preferences.explorerOpen,
        terminalOpen: preferences.terminalOpen,
      });
      setPreferencesHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth);
    updateViewport();
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  const viewport = useMemo(() => classifyViewport(
    viewportWidth,
    state.explorerOpen,
    explorerWidth,
    chatWidth,
  ), [chatWidth, explorerWidth, state.explorerOpen, viewportWidth]);

  useEffect(() => {
    dispatch({ type: 'VIEWPORT_CHANGED', viewport });
  }, [viewport]);

  useEffect(() => {
    if (!preferencesHydrated) return;
    try {
      writeNotebookLayoutPreferences(window.localStorage, {
        version: 2,
        explorerOpen: state.explorerOpen,
        explorerWidth,
        chatWidth,
        terminalOpen: state.terminalOpen,
      });
    } catch {
      // Layout persistence is optional; state remains valid for this session.
    }
  }, [
    chatWidth,
    explorerWidth,
    preferencesHydrated,
    state.explorerOpen,
    state.terminalOpen,
  ]);

  const setExplorerWidth = useCallback((value: number) => {
    setExplorerWidthState(Math.min(
      NOTEBOOK_EXPLORER_MAX_WIDTH,
      Math.max(NOTEBOOK_EXPLORER_MIN_WIDTH, value),
    ));
  }, []);

  const setChatWidth = useCallback((value: number) => {
    setChatWidthState(Math.min(
      NOTEBOOK_CHAT_MAX_WIDTH,
      Math.max(NOTEBOOK_CHAT_MIN_WIDTH, value),
    ));
  }, []);

  return {
    state,
    dispatch,
    viewportWidth,
    explorerWidth,
    setExplorerWidth,
    chatWidth,
    setChatWidth,
    preferencesHydrated,
    isMobile: state.viewport === 'mobile',
    isDesktop: state.viewport !== 'mobile',
    canDockChat: state.viewport === 'desktop-wide',
  };
}
