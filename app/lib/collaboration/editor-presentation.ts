import type { CollaborationDocument } from './client';
import { readRichDocumentJson } from './rich-document';
import { isRichTextCollaborationRepresentation } from './types';

/** A failed Markdown projection does not make a usable structured document unreadable. */
export function canRenderCollaborationDocument(collaboration: CollaborationDocument | null, markdownAvailable: boolean): boolean {
  if (markdownAvailable) return true;
  if (!collaboration?.ready || !isRichTextCollaborationRepresentation(collaboration.session?.representation)) return false;
  try { return readRichDocumentJson(collaboration.doc).type === 'doc'; } catch { return false; }
}

/** Ordinary sync, reconnect and projection work never creates a product status message. */
export function collaborationEditorIssue(collaboration: CollaborationDocument | null, markdownAvailable: boolean) {
  if (!collaboration) return null;
  if (collaboration.connection === 'denied') return 'authentication' as const;
  if (collaboration.clientState.failure) return collaboration.clientState.failure.kind;
  if (collaboration.durability === 'degraded') return 'unknown' as const;
  if (!collaboration.ready && collaboration.clientState.indexedDbHydrated && collaboration.connection === 'offline') return 'startup' as const;
  return collaboration.ready && !canRenderCollaborationDocument(collaboration, markdownAvailable)
    ? 'unavailable' as const : null;
}

export function collaborationDiagnosticsEnabled(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('collaborationDebug') === '1';
}

export function subscribeCollaborationDiagnostics(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
