import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import type { Editor } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Doc, Transaction as YTransaction } from 'yjs';

type ExistingMap = { size: number; get(key: string): unknown; entries(): IterableIterator<[unknown, unknown]> };
type Binding = {
  origin: object; ready: boolean; destroyed: boolean; lastError: string | null;
  options: { document: Doc };
  tree: null | { root: ExistingMap; records: ExistingMap; operations: { size: number } };
};
type NativeObservation = { finish(info: TestInfo): Promise<void> };

/** Diagnostic listeners only: FNV32 signatures are deliberately NOT durability proofs. */
export async function installPassiveNativeRichObservation(page: Page, selector: string,
  role: 'owner' | 'peer'): Promise<NativeObservation> {
  let key = '', installationFailed = false;
  const warn = (issue: string) => { try { console.warn('[i07-passive-native]', issue); } catch { /* Diagnostics never fail the test. */ } };
  try {
    key = `__canvas_i07_passive_${randomUUID().replaceAll('-', '')}`;
    await page.evaluate(({ key, selector }) => {
      const start = performance.now(), events: unknown[] = [], failures = new Set<string>();
      const ids = new WeakMap<object, number>(), editors = new WeakSet<Editor>(), documents = new WeakSet<Doc>();
      const cleanups: Array<() => void> = [];
      const passive = (observe: () => void) => { try { observe(); } catch { failures.add('listener_failed'); } };
      let serial = 0, editorCount = 0, documentCount = 0, dropped = 0, stopped = false, stopReason = 'collect';
      let current: Editor | null = null;
      const id = (value: unknown) => {
        if ((!value || typeof value !== 'object') && typeof value !== 'function') return 0;
        const object = value as object;
        let valueId = ids.get(object); if (!valueId) { valueId = ++serial; ids.set(object, valueId); }
        return valueId;
      };
      const hash = (value: string | Uint8Array) => {
        if (value.length > 65_536) return 'omitted-over-64Ki';
        let result = 0x811c9dc5;
        for (let index = 0; index < value.length; index++) {
          result = Math.imul(result ^ (typeof value === 'string' ? value.charCodeAt(index) : value[index]), 0x01000193);
        }
        return `fnv1a32:${(result >>> 0).toString(16).padStart(8, '0')}`;
      };
      const text = (value: string) => ({ chars: value.length, hash: hash(value), hasPeer: value.includes('Peer keeps this.') });
      const node = (value: EditorState['doc']) => value.content.size <= 65_536
        ? { blocks: value.childCount, size: value.content.size, ...text(value.textContent) }
        : { blocks: value.childCount, size: value.content.size, oversized: true };
      const binding = (value: Editor | null) => value
        ? (value.storage as { canvasBlockTreeCollaboration?: { binding?: Binding | null } }).canvasBlockTreeCollaboration?.binding ?? null : null;
      const code = (value: unknown) => {
        if (value == null) return 'none';
        return ['target_changed', 'structure_invalid', 'identity_invalid', 'format_mismatch']
          .find(part => value === `Block structure operation failed: ${part}.`) ?? 'other';
      };
      const origin = (value: unknown) => ({ id: id(value), kind: value === binding(current)?.origin ? 'active-binding'
        : value == null ? 'null' : typeof value === 'object' ? 'object' : typeof value === 'string' ? 'string' : 'other' });
      const native = (doc: Doc | undefined, stateBinding: Binding | null) => {
        if (!doc) return null;
        const clients: Array<{ client: number; clock: number }> = [];
        for (const [client, structs] of doc.store.clients) {
          const last = structs.at(-1); clients.push({ client, clock: last ? last.id.clock + last.length : 0 });
          if (clients.length === 32) break;
        }
        const coordinates = (value: unknown) => {
          const item = value && typeof value === 'object' ? Reflect.get(value, '_item') : null;
          const itemId = item && typeof item === 'object' ? Reflect.get(item, 'id') : null;
          const client = itemId && typeof itemId === 'object' ? Reflect.get(itemId, 'client') : null;
          const clock = itemId && typeof itemId === 'object' ? Reflect.get(itemId, 'clock') : null;
          return Number.isSafeInteger(client) && client >= 0 && Number.isSafeInteger(clock) && clock >= 0 ? { client, clock } : null;
        };
        const inventory = (value: ExistingMap | undefined) => {
          const rows: unknown[] = [];
          if (value?.entries) for (const [key, record] of value.entries()) {
            const content = record && typeof record === 'object' && typeof Reflect.get(record, 'get') === 'function'
              ? (record as ExistingMap).get('content') : null;
            rows.push({ keyHash: typeof key === 'string' ? hash(key) : 'invalid-key', recordId: id(record),
              recordItem: coordinates(record), contentId: id(content), contentItem: coordinates(content) });
            if (rows.length === 8) break;
          }
          return rows;
        };
        const tree = stateBinding?.options.document === doc ? stateBinding.tree : null;
        const root = doc.share.get('canvas-block-tree-v1') as unknown as ExistingMap | undefined;
        const currentRecords = root?.get ? root.get('records') as ExistingMap | undefined : undefined;
        return { id: id(doc), destroyed: doc.isDestroyed, localClient: doc.clientID,
          roots: doc.share.size, clientCount: doc.store.clients.size, clients,
          pendingStructs: doc.store.pendingStructs !== null, pendingDeletes: doc.store.pendingDs !== null,
          treeId: id(tree), rootId: id(root), retainedRootId: id(tree?.root), recordsId: id(tree?.records),
          currentRecordsId: id(currentRecords), records: tree?.records.size ?? null,
          currentRecords: tree ? currentRecords === tree.records : null,
          retainedRecords: inventory(tree?.records), liveRecords: inventory(currentRecords) };

      };
      const stop = (reason = 'collect') => {
        if (!stopped) {
          stopReason = reason; stopped = true; window.clearInterval(tick); window.clearTimeout(deadline);
          for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { failures.add('listener_cleanup_failed'); } }
          current = null;
        }
        return { version: 1, diagnosticOnly: true, nativeSemanticTextCaptured: false, signature: 'FNV1a32 UTF16/text or update-bytes; not a state proof',
          limits: { milliseconds: 60_000, events: 800, editors: 8, documents: 8, clientsPerSample: 32,
            textUnitsOrUpdateBytes: 65_536, recordIdentitiesPerMap: 8, rescanMilliseconds: 100 },
          elapsedMs: Math.round(performance.now() - start), stopReason, editorCount, documentCount, dropped,
          failures: [...failures], events };
      };
      const capture = (kind: string, extra: Record<string, unknown> = {}, observedDoc?: Doc) => {
        if (stopped) { dropped++; return; }
        if (events.length >= 800) { dropped++; stop('event-limit'); return; }
        try {
          const active = current && !current.isDestroyed ? current : null, bound = binding(active);
          const element = document.querySelector<HTMLElement>(selector);
          const doc = observedDoc ?? bound?.options.document;
          const state = active?.state;
          events.push({ sequence: events.length + 1, atMs: Math.round(performance.now() - start), kind,
            editorId: id(current), editorDestroyed: current?.isDestroyed ?? null, bindingId: id(bound),
            ready: bound?.ready ?? null, bindingDestroyed: bound?.destroyed ?? null, lastError: code(bound?.lastError),
            editable: active?.isEditable ?? null, focused: active?.isFocused ?? null,
            selection: state ? { from: state.selection.from, to: state.selection.to, anchor: state.selection.anchor, head: state.selection.head } : null,
            domPresent: Boolean(element), domConnected: element?.isConnected ?? false,
            dom: element && (element.textContent?.length ?? 0) <= 65_536 ? text(element.textContent ?? '') : null,
            pm: state ? node(state.doc) : null, native: native(doc, bound), ...extra });
        } catch { failures.add('snapshot_failed'); }
      };
      const watchDocument = (doc: Doc) => {
        if (documents.has(doc)) return; documents.add(doc);
        if (++documentCount > 8) { failures.add('document_limit'); stop('document-limit'); return; }
        const before = (transaction: YTransaction) => passive(() => capture('y.before', { origin: origin(transaction.origin), local: transaction.local }, doc));
        const after = (transaction: YTransaction) => passive(() => capture('y.after', { origin: origin(transaction.origin), local: transaction.local,
          changedTypes: transaction.changed.size, deletedClients: transaction.deleteSet.clients.size }, doc));
        const update = (value: Uint8Array, updateOrigin: unknown) => passive(() => capture('y.update', { origin: origin(updateOrigin), updateBytes: value.length, updateHash: hash(value) }, doc));
        const destroy = () => passive(() => capture('y.destroy', {}, doc));
        doc.on('beforeTransaction', before); doc.on('afterTransaction', after); doc.on('update', update); doc.on('destroy', destroy);
        cleanups.push(() => { doc.off('beforeTransaction', before); doc.off('afterTransaction', after); doc.off('update', update); doc.off('destroy', destroy); });
      };
      const transaction = (value: Transaction) => ({ docChanged: value.docChanged, selectionSet: value.selectionSet,
        steps: value.steps.length, remote: Boolean(value.getMeta('canvas-block-tree-remote')), history: value.getMeta('addToHistory') !== false });
      const scan = () => {
        if (stopped) return;
        try {
          const elements = document.querySelectorAll<HTMLElement & { editor?: Editor }>(selector);
          if (elements.length > 1) { failures.add('ambiguous_editor'); stop('ambiguous-editor'); return; }
          const found = elements[0]?.editor ?? null;
          current = found;
          if (found && !editors.has(found)) {
            editors.add(found);
            if (++editorCount > 8) { failures.add('editor_limit'); stop('editor-limit'); return; }
            const before = ({ transaction: value, nextState }: { transaction: Transaction; nextState: EditorState }) =>
              passive(() => capture('editor.before', { eventEditorId: id(found), transaction: transaction(value), nextPM: node(nextState.doc) }));
            const applied = ({ transaction: value }: { transaction: Transaction }) => passive(() => capture('editor.transaction', { eventEditorId: id(found), transaction: transaction(value) }));
            const destroy = () => passive(() => capture('editor.destroy', { eventEditorId: id(found) }));
            found.on('beforeTransaction', before); found.on('transaction', applied); found.on('destroy', destroy);
            cleanups.push(() => { found.off('beforeTransaction', before); found.off('transaction', applied); found.off('destroy', destroy); });
            capture('editor.discovered');
          }
          const doc = binding(found)?.options.document; if (doc) watchDocument(doc);
          capture('scan');
        } catch { failures.add('rescan_failed'); }
      };
      const input = (event: Event) => passive(() => {
        if (!(event.target instanceof Node) || !document.querySelector(selector)?.contains(event.target)) return;
        const value = event as InputEvent;
        scan(); // Discover a replacement before this input, without focusing or flushing it.
        capture(event.type, { input: ['insertText', 'insertCompositionText', 'insertFromPaste', 'deleteContentBackward']
          .includes(value.inputType) ? value.inputType : 'other', composing: value.isComposing });
      });
      Object.defineProperty(window, key, { value: { stop }, configurable: true });
      cleanups.push(() => { document.removeEventListener('beforeinput', input, true); document.removeEventListener('input', input, true); });
      document.addEventListener('beforeinput', input, { capture: true, passive: true });
      document.addEventListener('input', input, { capture: true, passive: true });
      const tick = window.setInterval(scan, 100);
      const deadline = window.setTimeout(() => passive(() => { stop('deadline'); }), 60_000); scan();
    }, { key, selector });
  } catch { installationFailed = true; warn('installation_failed'); }
  let finished: Promise<void> | undefined;
  return { finish(info) {
    return finished ??= (async () => {
      let report: Record<string, unknown>;
      try {
        report = await page.evaluate(key => {
          const owner = (window as unknown as Record<string, { stop(): Record<string, unknown> } | undefined>)[key];
          if (!owner) return { failures: ['observer_unavailable'] };
          const report = owner.stop(); Reflect.deleteProperty(window, key); return report;
        }, key);
      } catch { report = { failures: ['collection_failed'] }; }
      const nodeIssues: string[] = installationFailed ? ['installation_failed'] : [];
      if (Array.isArray(report.failures) && report.failures.length) warn('browser_observation_incomplete');
      const artifact = () => JSON.stringify({ role, installationFailed, nodeIssues, ...report });
      try {
        const filename = info.outputPath(`i07-passive-native-${role}.json`);
        await writeFile(filename, artifact(), { mode: 0o600, flag: 'wx' });
        try { await info.attach(`i07-passive-native-${role}`, { path: filename, contentType: 'application/json' }); }
        catch {
          nodeIssues.push('attachment_failed'); warn('attachment_failed');
          try { await writeFile(filename, artifact(), { mode: 0o600 }); } catch { warn('artifact_update_failed'); }
        }
      } catch { warn('artifact_write_failed'); }
    })().catch(() => { warn('finish_failed'); });
  } };
}
