/* eslint-disable @typescript-eslint/no-require-imports */
import 'server-only';

import type * as YjsRuntime from 'yjs';
import type { TiptapTransformer as TiptapTransformerRuntime } from '@hocuspocus/transformer';
import type * as YProsemirrorRuntime from 'y-prosemirror';

// The custom WebSocket server and Next route handlers share one Node process.
// Requiring these runtimes keeps both graphs on the same CommonJS Yjs module
// instance instead of mixing the package's CJS and ESM constructor sets.
export const Y = require('yjs') as typeof YjsRuntime;
export const TiptapTransformer = require('@hocuspocus/transformer')
  .TiptapTransformer as typeof TiptapTransformerRuntime;
export const YProsemirror = require('y-prosemirror') as typeof YProsemirrorRuntime;
