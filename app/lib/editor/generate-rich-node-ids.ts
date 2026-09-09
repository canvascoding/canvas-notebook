import { getSchema, type Extensions, type JSONContent } from '@tiptap/core';
import type { UniqueIDOptions } from '@tiptap/extension-unique-id';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/** Assign missing IDs without rebuilding a ProseMirror document for every node. */
export function generateRichNodeIds(input: JSONContent, extensions: Extensions): JSONContent {
  const uniqueId = extensions.find(extension => extension.name === 'uniqueID');
  if (!uniqueId) throw new Error('UniqueID extension not found in the extensions array');
  const schema = getSchema([...extensions.filter(extension => extension.name !== 'uniqueID'), uniqueId]);
  const { attributeName, generateID, types: configuredTypes } = uniqueId.options as UniqueIDOptions;
  const types = new Set(configuredTypes === 'all'
    ? Object.keys(schema.nodes).filter(type => type !== 'doc' && type !== 'text') : configuredTypes);
  const source = schema.nodeFromJSON(input);
  // Empty pre-hydration documents remain allowed. Nonempty invalid structures
  // must still fail instead of bypassing checks formerly made by PM steps.
  if (source.content.size) source.check();
  const result = source.toJSON() as JSONContent;
  // Walk the normalized node and its fresh JSON together. Positions and the
  // nodes passed to custom generators match UniqueID's original document;
  // authored IDs, attributes, marks and the caller's input are untouched.
  const visit = (node: ProseMirrorNode, json: JSONContent, start: number) => {
    node.forEach((child, offset, index) => {
      const value = json.content![index];
      const pos = start + offset;
      if (!child.attrs[attributeName] && types.has(child.type.name)) {
        value.attrs = child.type.create({ ...child.attrs, [attributeName]: generateID({ node: child, pos }) },
          child.content, child.marks).attrs;
      }
      if (child.childCount) visit(child, value, pos + 1);
    });
  };
  visit(source, result, 0);
  return result;
}
