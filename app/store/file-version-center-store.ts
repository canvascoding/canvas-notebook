'use client';

import { create } from 'zustand';

import {
  buildFileVersionCenterDeepLinkV1,
  parseFileVersionCenterDeepLinkV1,
  removeFileVersionCenterDeepLinkV1,
} from '@/app/lib/file-version-center/contracts/deep-link-v1';
import {
  parseFileVersionCenterRequestV1,
  type FileVersionCenterRequestV1,
  type FileVersionCenterSelectionV1,
} from '@/app/lib/file-version-center/contracts/v1';

type FileVersionCenterState = {
  request: FileVersionCenterRequestV1 | null;
};

type FileVersionCenterOpenOptions = {
  syncLocation?: boolean;
};

function browserHref(): string | null {
  if (typeof window === 'undefined') return null;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function replaceBrowserHref(href: string): void {
  if (typeof window === 'undefined' || href === browserHref()) return;
  window.history.replaceState(window.history.state, '', href);
}

export const useFileVersionCenterStore = create<FileVersionCenterState>(() => ({
  request: null,
}));

export function openVersionCenter(
  value: FileVersionCenterRequestV1,
  options: FileVersionCenterOpenOptions = {},
): FileVersionCenterRequestV1 {
  const request = parseFileVersionCenterRequestV1(value);
  if (options.syncLocation !== false) {
    const currentHref = browserHref();
    if (currentHref) replaceBrowserHref(buildFileVersionCenterDeepLinkV1(currentHref, request));
  }
  useFileVersionCenterStore.setState({ request });
  return request;
}

export function closeVersionCenter(options: FileVersionCenterOpenOptions = {}): void {
  if (options.syncLocation !== false) {
    const currentHref = browserHref();
    if (currentHref) replaceBrowserHref(removeFileVersionCenterDeepLinkV1(currentHref));
  }
  useFileVersionCenterStore.setState({ request: null });
}

export function syncVersionCenterFromLocation(search: string): FileVersionCenterRequestV1 | null {
  const request = parseFileVersionCenterDeepLinkV1(new URLSearchParams(search));
  if (request) openVersionCenter(request, { syncLocation: false });
  else closeVersionCenter({ syncLocation: false });
  return request;
}

export function selectVersionCenterEntry(
  selection: FileVersionCenterSelectionV1 | null,
): FileVersionCenterRequestV1 | null {
  const current = useFileVersionCenterStore.getState().request;
  if (!current) return null;
  const selectedEntry = selection ?? undefined;
  const initialView = selection?.kind === 'agent_operation' ? 'reviews' : 'history';
  if (current.selectedEntry?.kind === selectedEntry?.kind
    && current.selectedEntry?.id === selectedEntry?.id
    && current.initialView === initialView) return current;
  return openVersionCenter({
    ...current,
    selectedEntry,
    initialView,
  });
}
