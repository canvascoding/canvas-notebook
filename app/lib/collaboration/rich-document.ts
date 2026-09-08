import { getSchema, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { richMarkdownCodecExtensions } from '../markdown/rich-markdown-codec';
import { BLOCK_TREE_KEY, CollaborationBlockTree } from './block-tree';
import type { RichTextCollaborationRepresentation } from './types';

export type RichDocumentFormat = RichTextCollaborationRepresentation;

/** The durable root, never the mounted editor, determines how content is read. */
export function richDocumentFormat(doc: Y.Doc): RichDocumentFormat {
  return doc.share.has(BLOCK_TREE_KEY) ? 'tiptap_blocks' : 'tiptap_xml';
}

export function readRichDocumentJson(doc: Y.Doc, schema?: Schema): JSONContent {
  const resolvedSchema = schema ?? getSchema(richMarkdownCodecExtensions());
  if (richDocumentFormat(doc) === 'tiptap_blocks') {
    return new CollaborationBlockTree(doc, resolvedSchema).read().toJSON();
  }
  // XML emits empty mark attributes and omits null node defaults. Normalize
  // through the shared schema so format comparisons use the same JSON shape.
  return resolvedSchema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('body'))).toJSON();
}

/** Only visible block contents and frontmatter may be edited by an agent. */
export function blockTreeTextScopes(doc: Y.Doc, schema?: Schema): Map<Y.Text, string | null> {
  const tree = new CollaborationBlockTree(doc, schema ?? getSchema(richMarkdownCodecExtensions()));
  const scopes = new Map<Y.Text, string | null>();
  const visit = (fragment: Y.XmlFragment, blockId: string) => {
    for (const child of fragment.toArray()) {
      if (child instanceof Y.XmlText) scopes.set(child, blockId);
      else if (child instanceof Y.XmlElement) visit(child, blockId);
    }
  };
  tree.read().descendants((node) => {
    if (!node.inlineContent) return;
    visit(tree.content(node.attrs.id), node.attrs.id);
    return false;
  });
  if (doc.share.has('frontmatter')) scopes.set(doc.getText('frontmatter'), null);
  return scopes;
}
