import 'server-only';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { searchDocumentsForAgentTool } from '../documents/service';
import { decodePiDocumentSearchSelection, formatPiDocumentSearchError, formatPiDocumentSearchPage,
  piDocumentSearchParameters } from './document-search-tool-contract';

export function createDocumentSearchTool(): AgentTool {
  return { name: 'search_documents', label: 'Searching native documents',
    description: 'Search visible initialized native notebook text documents using literal text in the current workspace. Returns bounded whole hits with stable documentId, full content/metadata versions, snippets and explicit coverage. Ranking is within each bounded scan window; remote live coverage remains unknown. Follow nextCursor even when hits is empty. Physical files, Scenes and PDF bodies are outside this corpus; rg retains ordinary file/regex/tool-output search. Read a selected hit completely with read_document using documentId and expectedVersion=document.version; each read needs current read permission. Corpus changes never retry automatically.',
    parameters: piDocumentSearchParameters,
    execute: async (_toolCallId, params) => {
      try { return formatPiDocumentSearchPage(await searchDocumentsForAgentTool(decodePiDocumentSearchSelection(params))); }
      catch (error) { return formatPiDocumentSearchError(error); }
    } };
}
