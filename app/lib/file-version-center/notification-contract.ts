import { buildFileVersionCenterDeepLinkV1 } from './contracts/deep-link-v1';
import { FILE_VERSION_CENTER_CONTRACT_VERSION } from './contracts/v1';

export const FILE_CHANGE_REVIEW_NOTIFICATION_PREFIX = 'file-change:' as const;

export const FILE_CHANGE_REVIEW_NOTIFICATION_REASONS = [
  'needs_review',
  'partially_applied',
  'semantic_conflict',
  'direct_apply_failed',
] as const;

export type FileChangeReviewNotificationReason =
  (typeof FILE_CHANGE_REVIEW_NOTIFICATION_REASONS)[number];

export type FileChangeReviewNotificationTarget = {
  kind: 'file_change';
  workspaceId: string;
  lineageId: string;
  operationId: string;
};

export function fileChangeReviewNotificationItemId(operationId: string): string {
  return `${FILE_CHANGE_REVIEW_NOTIFICATION_PREFIX}${operationId}`;
}

export function buildFileChangeReviewCenterHref(
  target: FileChangeReviewNotificationTarget,
  href = '/notebook',
): string {
  const [withoutHash, hash = ''] = href.split('#', 2);
  const [pathname, query = ''] = withoutHash.split('?', 2);
  const params = new URLSearchParams(query);
  params.set('workspaceId', target.workspaceId);
  const workspaceHref = `${pathname}?${params.toString()}${hash ? `#${hash}` : ''}`;
  return buildFileVersionCenterDeepLinkV1(workspaceHref, {
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: {
      kind: 'lineage',
      workspaceId: target.workspaceId,
      lineageId: target.lineageId,
    },
    selectedEntry: { kind: 'agent_operation', id: target.operationId },
    initialView: 'reviews',
    source: 'notification',
  });
}
