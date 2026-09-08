import { Awareness } from 'y-protocols/awareness';
import type { Doc } from 'yjs';

const documents = new WeakMap<Doc, Awareness>();
type Listener = Parameters<Awareness['on']>[1];

/** A provider owns its listeners; the document owns presence clocks and timers. */
export function createDocumentAwarenessLease(doc: Doc): Awareness {
  let awareness = documents.get(doc);
  if (!awareness) {
    awareness = new Awareness(doc);
    documents.set(doc, awareness);
  } else {
    // End view-specific cursor/composition state without resetting its clock.
    awareness.setLocalState({});
  }
  const listeners = new Map<string, Set<Listener>>();
  let released = false;
  return new Proxy(awareness, {
    get(target, property, receiver) {
      if (property === 'on') return (event: string, listener: Listener) => {
        if (!released) {
          let group = listeners.get(event);
          if (!group) { group = new Set(); listeners.set(event, group); }
          group.add(listener);
          target.on(event, listener);
        }
        return listener;
      };
      if (property === 'off') return (event: string, listener: Listener) => {
        if (listeners.get(event)?.delete(listener)) target.off(event, listener);
      };
      if (property === 'setLocalState') return (...args: Parameters<Awareness['setLocalState']>) => {
        if (!released) target.setLocalState(...args);
      };
      if (property === 'setLocalStateField') return (...args: Parameters<Awareness['setLocalStateField']>) => {
        if (!released) target.setLocalStateField(...args);
      };
      if (property === 'destroy') return () => {
        released = true;
        for (const [event, group] of listeners) for (const listener of group) target.off(event, listener);
        listeners.clear();
      };
      return Reflect.get(target, property, receiver);
    },
  });
}
