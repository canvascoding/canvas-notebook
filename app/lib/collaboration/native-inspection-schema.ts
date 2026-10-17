import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { richMarkdownCodecExtensions } from '../markdown/rich-markdown-codec';

type InspectionSchemaFrame = { active: boolean; schema: Schema | null };
const frames = new AsyncLocalStorage<InspectionSchemaFrame>();

function assertActive(frame: InspectionSchemaFrame | undefined): void {
  if (frame && !frame.active) {
    throw Object.assign(new Error('The native inspection schema scope has ended.'), {
      code: 'NATIVE_INSPECTION_SCHEMA_SCOPE_EXPIRED',
    });
  }
}

/** Fixed grammar only. Document contents and validation results are never cached.
 * ProseMirror owns mutable internal schema caches; consumers must not change its
 * specifications or default attributes. Only Schema is stored; its framework
 * bindings remain internal. */
export function getNativeInspectionSchema(): Schema {
  const frame = frames.getStore();
  assertActive(frame);
  if (!frame) return getSchema(richMarkdownCodecExtensions());
  return frame.schema ??= getSchema(richMarkdownCodecExtensions());
}

/** A fresh grammar lifetime for one fully awaited transaction attempt. Nested
 * calls are independent; inherited children cannot reuse or revive an old frame. */
export async function withNativeInspectionSchema<T>(operation: () => T | Promise<T>): Promise<T> {
  assertActive(frames.getStore());
  const frame: InspectionSchemaFrame = { active: true, schema: null };
  try {
    return await frames.run(frame, operation);
  } finally {
    frame.active = false;
    frame.schema = null;
  }
}
