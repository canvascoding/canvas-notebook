'use client';

import { createContext, useContext } from 'react';

export type WorkspaceBrandingContextValue = {
  workspaceId: string | null;
  brandName: string;
  logoUrl: string | null;
};

export const DEFAULT_WORKSPACE_BRANDING: WorkspaceBrandingContextValue = {
  workspaceId: null,
  brandName: '',
  logoUrl: null,
};

export const WorkspaceBrandingContext = createContext<WorkspaceBrandingContextValue>(
  DEFAULT_WORKSPACE_BRANDING,
);

export function useWorkspaceBranding(): WorkspaceBrandingContextValue {
  return useContext(WorkspaceBrandingContext);
}
