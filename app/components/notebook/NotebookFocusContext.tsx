'use client';

import { createContext } from 'react';

/** Presentation only: never changes persisted panel preferences or the live document. */
export const NotebookFocusContext = createContext<{
  focused: boolean;
  setFocused: (focused: boolean) => void;
} | null>(null);
