import { combineTransactionSteps } from '@tiptap/core';
import UniqueID from '@tiptap/extension-unique-id';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/** Keep IDs unique when a structural edit copies an ancestor outside its changed range. */
export const CanvasUniqueID = UniqueID.extend({
  addProseMirrorPlugins() {
    const plugins = this.parent?.() ?? [];
    if (!this.options.updateDocument) return plugins;
    const { attributeName, filterTransaction, generateID, types } = this.options;
    return [...plugins, new Plugin({
      key: new PluginKey('canvasUniqueID'),
      appendTransaction(transactions, oldState, newState) {
        if (!transactions.some((transaction) => transaction.docChanged)
          || oldState.doc.eq(newState.doc)
          || transactions.some((transaction) => transaction.getMeta('y-sync$')
            || (filterTransaction && !filterTransaction(transaction)))) return;

        // UniqueID checks only changed ranges. Lifting the middle item of a list
        // splits its parent, and the two list nodes can fall outside those ranges.
        const positions = new Map<string, number[]>();
        newState.doc.descendants((node, pos) => {
          if (node.isText || (types !== 'all' && !types.includes(node.type.name))) return;
          const id = node.attrs[attributeName];
          if (typeof id !== 'string' || !id) return;
          const group = positions.get(id) ?? [];
          group.push(pos);
          positions.set(id, group);
        });
        const duplicates = new Map([...positions].filter(([, group]) => group.length > 1));
        if (!duplicates.size) return;

        const { mapping } = combineTransactionSteps(oldState.doc, [...transactions]);
        const retained = new Map<string, number>();
        oldState.doc.descendants((node, pos) => {
          const id = node.attrs[attributeName];
          if (!duplicates.has(id) || retained.has(id)) return;
          const mapped = mapping.mapResult(pos);
          if (!mapped.deleted && duplicates.get(id)!.includes(mapped.pos)) retained.set(id, mapped.pos);
        });

        const tr = newState.tr;
        const used = new Set(positions.keys());
        for (const [id, group] of duplicates) {
          const keep = retained.get(id) ?? group[0];
          for (const pos of group) {
            if (pos === keep) continue;
            const node = tr.doc.nodeAt(pos)!;
            let replacement: string;
            do { replacement = generateID({ node, pos }); } while (used.has(replacement));
            used.add(replacement);
            tr.setNodeAttribute(pos, attributeName, replacement);
          }
        }
        tr.setStoredMarks(newState.storedMarks);
        tr.setMeta('__uniqueIDTransaction', true);
        return tr;
      },
    })];
  },
});
