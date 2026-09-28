import 'server-only';

import {
  captureCollaborationAdmissionDrainTicket,
  sameCollaborationAdmissionDrainTicket,
  type CollaborationAdmissionDrainTicket,
} from './room-admission-drain';
import type { CollaborationRoomOwnerFence } from './room-owner';

export type CollaborationRoomAdmissionWorkerOptions = Readonly<{
  getOwnedFences: () => readonly CollaborationRoomOwnerFence[];
  pendingDrains: (
    fences: readonly CollaborationRoomOwnerFence[],
  ) => Promise<readonly CollaborationAdmissionDrainTicket[]>;
  drain: (ticket: CollaborationAdmissionDrainTicket) => Promise<void>;
  pollMs?: number;
  onError?: (error: unknown) => void;
}>;

/** Durable polling is authoritative; wake() only coalesces optional hints. */
export function createCollaborationRoomAdmissionWorker(options: CollaborationRoomAdmissionWorkerOptions) {
  const pollMs = options.pollMs ?? 1_000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 60_000) {
    throw new Error('Invalid collaboration admission poll interval.');
  }
  let disposed = false;
  let running = false;
  let rerun = false;
  let timer: NodeJS.Timeout | undefined;
  const report = (error: unknown) => {
    try { options.onError?.(error); }
    catch { console.error('[Collaboration] Admission drain error handler failed.'); }
  };
  const schedule = (delay: number) => {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delay);
    timer.unref();
  };
  const poll = async () => {
    if (disposed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      const fences = Object.freeze([...options.getOwnedFences()]);
      if (fences.length > 256) throw new Error('Collaboration admission owner set exceeds its bound.');
      const inputs = await options.pendingDrains(fences);
      if (!Array.isArray(inputs) || inputs.length > 256) {
        throw new Error('Collaboration admission drain set exceeds its bound.');
      }
      const tickets: CollaborationAdmissionDrainTicket[] = [];
      for (const input of inputs) {
        const ticket = captureCollaborationAdmissionDrainTicket(input);
        if (!tickets.some((other) => sameCollaborationAdmissionDrainTicket(ticket, other))) tickets.push(ticket);
      }
      for (const ticket of tickets) {
        if (disposed) break;
        try { await options.drain(ticket); }
        catch (error) { report(error); }
      }
    } catch (error) { report(error); }
    finally {
      running = false;
      if (!disposed) {
        const immediate = rerun;
        rerun = false;
        schedule(immediate ? Math.min(pollMs, 25) : pollMs);
      }
    }
  };
  const wake = () => {
    if (disposed) return;
    if (running) {
      rerun = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    schedule(0);
  };
  wake();
  return {
    wake,
    dispose() {
      if (disposed) return;
      disposed = true;
      rerun = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
