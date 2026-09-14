import {
  FILE_VERSION_CENTER_CONTRACT_LIMITS,
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  parseFileVersionCenterRequestV1,
  type FileVersionCenterRequestV1,
  type FileVersionCenterSelectionV1,
  type FileVersionCenterTargetV1,
} from './v1';

export const FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1 = Object.freeze({
  version: 'fvrc',
  targetKind: 'fvrcTarget',
  workspaceId: 'fvrcWorkspace',
  targetRef: 'fvrcRef',
  entryId: 'fvrcChangeEntry',
  initialView: 'fvrcView',
  selectedKind: 'fvrcSelectedKind',
  selectedId: 'fvrcSelectedId',
} as const);

type SearchParamsReader = Pick<URLSearchParams, 'get'>;

function splitHref(href: string): { pathname: string; query: string; hash: string } {
  const [withoutHash, hash = ''] = href.split('#', 2);
  const [pathname, query = ''] = withoutHash.split('?', 2);
  return { pathname, query, hash };
}

function targetRef(target: FileVersionCenterTargetV1): string {
  if (target.kind === 'lineage') return target.lineageId;
  if (target.kind === 'document') return target.documentId;
  if (target.kind === 'change_group') return target.changeGroupId;
  return target.pathHint;
}

function targetFromParams(params: SearchParamsReader): FileVersionCenterTargetV1 | null {
  const kind = params.get(FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1.targetKind);
  const workspaceId = params.get(FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1.workspaceId);
  const reference = params.get(FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1.targetRef);
  if (!workspaceId || !reference) return null;
  if (kind === 'lineage') return { kind, workspaceId, lineageId: reference };
  if (kind === 'document') return { kind, workspaceId, documentId: reference };
  if (kind === 'path') return { kind, workspaceId, pathHint: reference };
  if (kind === 'change_group') {
    const entryId = params.get(FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1.entryId) || undefined;
    return { kind, workspaceId, changeGroupId: reference, entryId };
  }
  return null;
}

function selectedEntryFromParams(params: SearchParamsReader): FileVersionCenterSelectionV1 | undefined {
  const kind = params.get(FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1.selectedKind);
  const id = params.get(FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1.selectedId);
  if (!id) return undefined;
  if (kind === 'agent_operation' || kind === 'revision') return { kind, id };
  return undefined;
}

function assertDeepLinkSize(params: URLSearchParams): void {
  if (new TextEncoder().encode(params.toString()).byteLength > FILE_VERSION_CENTER_CONTRACT_LIMITS.deepLinkCharacters) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.payloadTooLarge,
      'The file version center deep link exceeds the contract limit.',
    );
  }
}

export function buildFileVersionCenterDeepLinkV1(
  href: string,
  requestValue: FileVersionCenterRequestV1,
): string {
  const request = parseFileVersionCenterRequestV1(requestValue);
  const { pathname, query, hash } = splitHref(href);
  const params = new URLSearchParams(query);
  const keys = FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1;

  params.set(keys.version, String(FILE_VERSION_CENTER_CONTRACT_VERSION));
  params.set(keys.targetKind, request.target.kind);
  params.set(keys.workspaceId, request.target.workspaceId);
  params.set(keys.targetRef, targetRef(request.target));
  params.set(keys.initialView, request.initialView);
  if (request.target.kind === 'change_group' && request.target.entryId) {
    params.set(keys.entryId, request.target.entryId);
  } else {
    params.delete(keys.entryId);
  }
  if (request.selectedEntry) {
    params.set(keys.selectedKind, request.selectedEntry.kind);
    params.set(keys.selectedId, request.selectedEntry.id);
  } else {
    params.delete(keys.selectedKind);
    params.delete(keys.selectedId);
  }
  assertDeepLinkSize(params);
  const nextQuery = params.toString();
  return `${pathname}${nextQuery ? `?${nextQuery}` : ''}${hash ? `#${hash}` : ''}`;
}

export function parseFileVersionCenterDeepLinkV1(
  params: SearchParamsReader,
): FileVersionCenterRequestV1 | null {
  const rawVersion = params.get(FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1.version);
  if (rawVersion === null) return null;
  if (rawVersion !== String(FILE_VERSION_CENTER_CONTRACT_VERSION)) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.unsupportedVersion,
      'The file version center deep link version is not supported.',
    );
  }
  const target = targetFromParams(params);
  if (!target) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.invalidTarget,
      'The file version center deep link target is incomplete.',
    );
  }
  const initialView = params.get(FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1.initialView);
  const request = {
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target,
    initialView: initialView === 'reviews' ? 'reviews' as const : 'history' as const,
    source: 'deep_link' as const,
    selectedEntry: selectedEntryFromParams(params),
  };
  return parseFileVersionCenterRequestV1(request);
}

export function removeFileVersionCenterDeepLinkV1(href: string): string {
  const { pathname, query, hash } = splitHref(href);
  const params = new URLSearchParams(query);
  for (const key of Object.values(FILE_VERSION_CENTER_DEEP_LINK_KEYS_V1)) params.delete(key);
  const nextQuery = params.toString();
  return `${pathname}${nextQuery ? `?${nextQuery}` : ''}${hash ? `#${hash}` : ''}`;
}
