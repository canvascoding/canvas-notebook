/**
 * Global Event Emitter for PI Runtime Events
 * 
 * This allows the PI Runtime to broadcast events to WebSocket clients
 * without creating circular dependencies or importing server-only modules.
 */

import { EventEmitter } from 'events';

interface PiRuntimeEvent {
  sessionId: string;
  userId: string;
  event: Record<string, unknown>;
  timestamp: number;
}

class PiRuntimeEventEmitter extends EventEmitter {
  private static instance: PiRuntimeEventEmitter;
  
  private constructor() {
    super();
  }
  
  static getInstance(): PiRuntimeEventEmitter {
    if (!PiRuntimeEventEmitter.instance) {
      PiRuntimeEventEmitter.instance = new PiRuntimeEventEmitter();
    }
    return PiRuntimeEventEmitter.instance;
  }
  
  emitEvent(sessionId: string, userId: string, event: Record<string, unknown>): void {
    this.emit('agent_event', {
      sessionId,
      userId,
      event,
      timestamp: Date.now(),
    } as PiRuntimeEvent);
  }
  
  onAgentEvent(listener: (data: PiRuntimeEvent) => void): void {
    this.on('agent_event', listener);
  }
  
  offAgentEvent(listener: (data: PiRuntimeEvent) => void): void {
    this.off('agent_event', listener);
  }
}

// Global singleton
const globalEmitter = globalThis as typeof globalThis & {
  __piRuntimeEventEmitter?: PiRuntimeEventEmitter;
};

export function getPiRuntimeEventEmitter(): PiRuntimeEventEmitter {
  if (!globalEmitter.__piRuntimeEventEmitter) {
    globalEmitter.__piRuntimeEventEmitter = PiRuntimeEventEmitter.getInstance();
  }
  return globalEmitter.__piRuntimeEventEmitter;
}
