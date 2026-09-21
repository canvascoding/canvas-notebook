'use client';

import { create } from 'zustand';
import type { MemoryReviewDecision, MemoryReviewEntry, MemoryReviewTarget } from '@/app/lib/memory/contract';
import { decideMemoryReviewClient, loadMemoryReview, MemoryReviewClientError } from '@/app/lib/memory/review-client';

type State = { open: boolean; queue: MemoryReviewTarget[]; activeIndex: number; activeEntry: MemoryReviewEntry | null; loading: boolean; deciding: boolean; error: string | null; completed: boolean };
export const useMemoryReviewStore = create<State>(() => ({ open: false, queue: [], activeIndex: 0, activeEntry: null, loading: false, deciding: false, error: null, completed: false }));

function key(target: MemoryReviewTarget) { return `${target.scope}:${target.collectionId}:${target.entryId}`; }
function uniqueQueue(targets: MemoryReviewTarget[]) { return [...new Map(targets.map((target) => [key(target), target])).values()]; }

async function loadAt(index: number, queue: MemoryReviewTarget[]) {
  useMemoryReviewStore.setState({ activeIndex: index, activeEntry: null, loading: true, error: null, completed: false });
  try {
    const entry = await loadMemoryReview(queue[index]);
    useMemoryReviewStore.setState({ activeEntry: entry, loading: false });
  } catch (error) {
    if (error instanceof MemoryReviewClientError && (error.status === 404 || error.status === 409)) {
      const next = queue.slice(); next.splice(index, 1);
      if (!next.length) { useMemoryReviewStore.setState({ queue: [], loading: false, completed: true }); return; }
      useMemoryReviewStore.setState({ queue: next }); await loadAt(Math.min(index, next.length - 1), next); return;
    }
    useMemoryReviewStore.setState({ loading: false, error: error instanceof Error ? error.message : 'Unable to load memory review.' });
  }
}

export async function openMemoryReview(target: MemoryReviewTarget, available: MemoryReviewTarget[] = []) {
  const queue = uniqueQueue([target, ...available]);
  useMemoryReviewStore.setState({ open: true, queue, activeIndex: 0, activeEntry: null, completed: false, error: null });
  await loadAt(0, queue);
}
export function closeMemoryReview() { useMemoryReviewStore.setState({ open: false, activeEntry: null, error: null }); }

export async function decideActiveMemory(decision: MemoryReviewDecision) {
  const state = useMemoryReviewStore.getState();
  if (!state.activeEntry || state.deciding) return;
  useMemoryReviewStore.setState({ deciding: true, error: null });
  try {
    await decideMemoryReviewClient(state.activeEntry, decision);
    const queue = state.queue.filter((_, index) => index !== state.activeIndex);
    window.dispatchEvent(new CustomEvent('memory_review_updated'));
    window.dispatchEvent(new CustomEvent('notification_summary_updated'));
    if (!queue.length) { useMemoryReviewStore.setState({ queue: [], activeEntry: null, deciding: false, completed: true }); return; }
    useMemoryReviewStore.setState({ queue, deciding: false });
    await loadAt(Math.min(state.activeIndex, queue.length - 1), queue);
  } catch (error) { useMemoryReviewStore.setState({ deciding: false, error: error instanceof Error ? error.message : 'Unable to save decision.' }); }
}

export const approveActiveMemory = () => decideActiveMemory('approve');
export const rejectActiveMemory = () => decideActiveMemory('reject');
