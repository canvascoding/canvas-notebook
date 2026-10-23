import 'server-only';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { readDocumentForAgentTool } from '../documents/service';
import {
  decodePiDocumentReadSelection,
  formatPiDocumentReadError,
  formatPiDocumentReadPage,
  piDocumentReadParameters,
} from './document-read-tool-contract';

/** The existing runtime wrapper supplies the genuine current tool invocation. */
export function createDocumentReadTool(): AgentTool {
  return {
    name: 'read_document',
    label: 'Reading native document',
    description: 'Read an existing native notebook document by stable documentId in this session\'s workspace. Returns a complete bounded page with full native version, metadata version, currency and projection status. Defaults to native JSON; concatenate fragments before parsing the native body. Continue with the exact nextCursor until complete is true and nextCursor is null. Every call checks current access and version; conflicts never refresh automatically. An output-budget error returns no page: a new explicitly requested call may use a smaller maxBytes and the original input cursor. Use read for ordinary file paths, PDFs, images and saved tool outputs.',
    parameters: piDocumentReadParameters,
    execute: async (_toolCallId, params) => {
      try {
        const selection = decodePiDocumentReadSelection(params);
        return formatPiDocumentReadPage(await readDocumentForAgentTool(selection));
      } catch (error) {
        return formatPiDocumentReadError(error);
      }
    },
  };
}
