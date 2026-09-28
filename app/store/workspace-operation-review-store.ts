'use client';

import { create } from 'zustand';

import { closeVersionCenter } from '@/app/store/file-version-center-store';

export type WorkspaceOperationReviewRequest =
  | { mode: 'detail'; reviewId: string; workspaceId: string }
  | { mode: 'list'; workspaceId: string };

type WorkspaceOperationReviewState = {
  request: WorkspaceOperationReviewRequest | null;
};

export const useWorkspaceOperationReviewStore = create<WorkspaceOperationReviewState>(() => ({ request: null }));

export function openWorkspaceOperationReview(reviewId: string, workspaceId: string): void {
  if (!reviewId || !workspaceId) return;
  closeVersionCenter();
  useWorkspaceOperationReviewStore.setState({ request: { mode: 'detail', reviewId, workspaceId } });
}

export function openWorkspaceOperationReviewList(workspaceId: string): void {
  if (!workspaceId) return;
  closeVersionCenter();
  useWorkspaceOperationReviewStore.setState({ request: { mode: 'list', workspaceId } });
}

export function closeWorkspaceOperationReview(): void {
  useWorkspaceOperationReviewStore.setState({ request: null });
}
