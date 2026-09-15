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
import {
  fileChangeReviewNotificationItemId,
  type FileChangeReviewNotificationTarget,
} from '@/app/lib/file-version-center/notification-contract';

type FileVersionCenterState = {
  request: FileVersionCenterRequestV1 | null;
};

type FileVersionCenterOpenOptions = {
  syncLocation?: boolean;
};

type TrustedFileChangeReviewIntent = {
  generation: number;
  requestGeneration: number;
  workspaceId: string;
  lineageId: string;
  operationId: string;
  itemId: string;
  state: 'pending' | 'acknowledged';
};

export type FileChangeReviewAcknowledgement = Pick<
  TrustedFileChangeReviewIntent,
  'generation' | 'workspaceId' | 'itemId'
>;

let requestGeneration = 0;
let trustedIntentGeneration = 0;
let trustedFileChangeReviewIntent: TrustedFileChangeReviewIntent | null = null;

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

function commitVersionCenterRequest(
  request: FileVersionCenterRequestV1,
  options: FileVersionCenterOpenOptions,
  trustedTarget?: FileChangeReviewNotificationTarget,
): FileVersionCenterRequestV1 {
  requestGeneration += 1;
  trustedFileChangeReviewIntent = trustedTarget ? {
    generation: ++trustedIntentGeneration,
    requestGeneration,
    workspaceId: trustedTarget.workspaceId,
    lineageId: trustedTarget.lineageId,
    operationId: trustedTarget.operationId,
    itemId: fileChangeReviewNotificationItemId(trustedTarget.operationId),
    state: 'pending',
  } : null;
  if (options.syncLocation !== false) {
    const currentHref = browserHref();
    if (currentHref) replaceBrowserHref(buildFileVersionCenterDeepLinkV1(currentHref, request));
  }
  useFileVersionCenterStore.setState({ request });
  return request;
}

export function openVersionCenter(
  value: FileVersionCenterRequestV1,
  options: FileVersionCenterOpenOptions = {},
): FileVersionCenterRequestV1 {
  const request = parseFileVersionCenterRequestV1(value);
  return commitVersionCenterRequest(request, options);
}

export function openVersionCenterFromNotification(
  target: FileChangeReviewNotificationTarget,
  options: FileVersionCenterOpenOptions = {},
): FileVersionCenterRequestV1 {
  const request = parseFileVersionCenterRequestV1({
    contractVersion: 1,
    target: {
      kind: 'lineage',
      workspaceId: target.workspaceId,
      lineageId: target.lineageId,
    },
    selectedEntry: { kind: 'agent_operation', id: target.operationId },
    initialView: 'reviews',
    source: 'notification',
  });
  return commitVersionCenterRequest(request, options, target);
}

export function closeVersionCenter(options: FileVersionCenterOpenOptions = {}): void {
  requestGeneration += 1;
  trustedFileChangeReviewIntent = null;
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
  if (trustedFileChangeReviewIntent
    && (selectedEntry?.kind !== 'agent_operation'
      || selectedEntry.id !== trustedFileChangeReviewIntent.operationId)) {
    trustedFileChangeReviewIntent = null;
  }
  const request = parseFileVersionCenterRequestV1({
    ...current,
    selectedEntry,
    initialView,
  });
  const currentHref = browserHref();
  if (currentHref) replaceBrowserHref(buildFileVersionCenterDeepLinkV1(currentHref, request));
  useFileVersionCenterStore.setState({ request });
  return request;
}

export function claimFileChangeReviewAcknowledgement(input: {
  request: FileVersionCenterRequestV1;
  workspaceId: string;
  lineageId: string;
  operationId: string;
}): FileChangeReviewAcknowledgement | null {
  const intent = trustedFileChangeReviewIntent;
  if (
    !intent
    || intent.state !== 'pending'
    || intent.requestGeneration !== requestGeneration
    || useFileVersionCenterStore.getState().request !== input.request
    || input.request.source !== 'notification'
    || intent.workspaceId !== input.workspaceId
    || intent.lineageId !== input.lineageId
    || intent.operationId !== input.operationId
  ) return null;
  intent.state = 'acknowledged';
  return {
    generation: intent.generation,
    workspaceId: intent.workspaceId,
    itemId: intent.itemId,
  };
}

export function releaseFileChangeReviewAcknowledgement(generation: number): void {
  if (trustedFileChangeReviewIntent?.generation === generation) {
    trustedFileChangeReviewIntent.state = 'pending';
  }
}
